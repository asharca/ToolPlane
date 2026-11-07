import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { A2AHttpError } from "@/lib/a2a/principal";
import { TaskNotFoundError } from "@a2a-js/sdk/errors";
import {
  AGENT_API_SSE_HEADERS,
  encodeSseEvent,
  encodeSseHeartbeat,
} from "@/lib/agents/public-api/sse";
import { observeWorkspaceStreamRevocation } from "@/lib/workspace/access-stream";
import { subscribeTaskOutput, taskOutput } from "./live-output";
import type { LiveTaskOutput } from "./live-output-types";

export type Observation = {
  workspaceId: string;
  userId: string;
  output: LiveTaskOutput | null;
  settled: boolean;
};
/** Snapshots coalesce before serialization; downstream has one queued frame and
 * at most one pending snapshot/settlement. A slow or disconnected reader cannot
 * retain an unbounded token/event queue. No stream path ever submits work. */
export function executionOutputResponse(
  req: Request,
  initial: Observation,
  load: () => Promise<Observation>,
  followConversation = false,
) {
  // Publishers run in another request (for example channel ingress). Recheck
  // cookies and permissions in the observer's context, never the publisher's.
  const loadObservation = AsyncLocalStorage.bind(load);
  let dispose = () => {};
  let pull = () => {};
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        let closed = false,
          revoked = false,
          refreshing = false,
          refreshAgain = false;
        let current = initial;
        let pendingSnapshot = true,
          pendingSettled: string | null = null;
        let lastSettled: string | null = null;
        let flushTimer: ReturnType<typeof setTimeout> | undefined;
        const unsubscribe = subscribeTaskOutput((taskId, reason) => {
          if (closed || revoked) return;
          if (current.output?.taskId === taskId) {
            if (reason === "update" && current.output.active) schedule();
            else void refresh();
          } else if (followConversation && reason === "start") void refresh();
        });
        const revokeSubscription = observeWorkspaceStreamRevocation(
          initial.workspaceId,
          initial.userId,
          revoke,
        );
        function close() {
          if (closed) return;
          closed = true;
          clearTimeout(flushTimer);
          clearInterval(recheck);
          clearInterval(heartbeat);
          unsubscribe();
          revokeSubscription();
          req.signal.removeEventListener("abort", close);
          try {
            controller.close();
          } catch {
            /* reader already cancelled */
          }
        }
        function flush() {
          clearTimeout(flushTimer);
          flushTimer = undefined;
          if (closed || (controller.desiredSize ?? 0) <= 0) return;
          if (revoked) {
            controller.enqueue(encodeSseEvent("revoked", {}));
            close();
            return;
          }
          if (pendingSnapshot) {
            pendingSnapshot = false;
            if (current.output?.active) {
              const live = taskOutput(current.output.taskId);
              if (live) current = { ...current, output: live };
            }
            controller.enqueue(
              encodeSseEvent("snapshot", { output: current.output }),
            );
          } else if (pendingSettled) {
            const taskId = pendingSettled;
            pendingSettled = null;
            controller.enqueue(encodeSseEvent("settled", { taskId }));
          }
        }
        function schedule() {
          pendingSnapshot = true;
          if (!flushTimer) flushTimer = setTimeout(flush, 50);
        }
        function revoke() {
          if (closed || revoked) return;
          revoked = true;
          current = { ...current, output: null };
          pendingSnapshot = false;
          pendingSettled = null;
          unsubscribe();
          revokeSubscription();
          clearInterval(recheck);
          clearInterval(heartbeat);
          flush();
        }
        function accept(observation: Observation) {
          current = observation;
          const taskId = observation.output?.taskId;
          const turn = taskId
            ? `${taskId}:${observation.output?.startedAt ?? ""}`
            : null;
          if (observation.output?.active) lastSettled = null;
          if (observation.settled && taskId && turn !== lastSettled) {
            lastSettled = turn;
            pendingSettled = taskId;
          }
          schedule();
        }
        async function refresh() {
          if (closed || revoked) return;
          if (refreshing) {
            refreshAgain = true;
            return;
          }
          refreshing = true;
          try {
            const observation = await loadObservation();
            if (!closed && !revoked) accept(observation);
          } catch (error) {
            if (
              error instanceof TaskNotFoundError ||
              (error instanceof A2AHttpError &&
                [401, 403, 404].includes(error.status))
            )
              revoke();
            else close(); // Transient storage/network failure reconnects; never falsely declares revocation.
          } finally {
            refreshing = false;
            if (refreshAgain) {
              refreshAgain = false;
              void refresh();
            }
          }
        }
        const recheck = setInterval(() => {
          void refresh();
        }, 5000);
        recheck.unref?.();
        const heartbeat = setInterval(() => {
          if (
            !closed &&
            !revoked &&
            !pendingSnapshot &&
            !pendingSettled &&
            (controller.desiredSize ?? 0) > 0
          )
            controller.enqueue(encodeSseHeartbeat());
        }, 15_000);
        heartbeat.unref?.();
        pull = flush;
        dispose = close;
        req.signal.addEventListener("abort", close, { once: true });
        accept(initial);
        flush();
        // Close the lookup/subscription race, including a newly admitted next turn.
        void refresh();
        if (req.signal.aborted) close();
      },
      pull() {
        pull();
      },
      cancel() {
        dispose();
      },
    },
    { highWaterMark: 1 },
  );
  return new Response(body, { headers: AGENT_API_SSE_HEADERS });
}
