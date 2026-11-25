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
import type {
  LiveTaskDeltaEvent,
  LiveTaskOutput,
  LiveTaskSnapshotEvent,
  ToolApprovalDataPart,
} from "./live-output-types";
import type { ToolApprovalCard } from "./tool-approvals";

export type Observation = {
  workspaceId: string;
  userId: string;
  output: LiveTaskOutput | null;
  settled: boolean;
  toolApprovals?: ToolApprovalCard[];
};
type Sent = { output: LiveTaskOutput; fields: string; dataParts: string };
/** A snapshot for a new connection, task turn or null output; otherwise the
 * changes since the client's last frame. Every frame advances `seq` by one. */
function encodeOutput(
  seq: number,
  sent: Sent | null,
  output: LiveTaskOutput | null,
  dataParts: ToolApprovalDataPart[],
) {
  if (!output)
    return {
      frame: encodeSseEvent("snapshot", {
        seq,
        output,
        dataParts,
      } satisfies LiveTaskSnapshotEvent),
      sent: null,
    };
  const { text, activities, ...fields } = output;
  const next: Sent = {
    output,
    fields: JSON.stringify(fields),
    dataParts: JSON.stringify(dataParts),
  };
  if (
    !sent ||
    sent.output.taskId !== output.taskId ||
    sent.output.startedAt !== output.startedAt
  )
    return {
      frame: encodeSseEvent("snapshot", {
        seq,
        output,
        dataParts,
      } satisfies LiveTaskSnapshotEvent),
      sent: next,
    };
  const previous = sent.output;
  const delta: LiveTaskDeltaEvent = { seq, taskId: output.taskId };
  if (text !== previous.text) {
    let at = previous.text.length;
    // Redaction can rewrite the unsettled tail; resend from the first difference.
    if (!text.startsWith(previous.text)) {
      at = 0;
      while (
        at < text.length &&
        text.charCodeAt(at) === previous.text.charCodeAt(at)
      )
        at++;
    }
    delta.textAt = at;
    delta.text = text.slice(at);
  }
  // Live activities keep their identity until changed; only replayed ones need JSON.
  const before = new Map(previous.activities.map((item) => [item.id, item]));
  const changed = activities.filter((item) => {
    const old = before.get(item.id);
    return (
      old !== item && (!old || JSON.stringify(old) !== JSON.stringify(item))
    );
  });
  if (changed.length) delta.activities = changed;
  if (
    activities.length !== previous.activities.length ||
    activities.some((item, index) => item.id !== previous.activities[index]?.id)
  )
    delta.activityIds = activities.map((item) => item.id);
  if (next.fields !== sent.fields) delta.fields = fields;
  if (next.dataParts !== sent.dataParts) delta.dataParts = dataParts;
  return { frame: encodeSseEvent("delta", delta), sent: next };
}
/** Output changes coalesce into one snapshot or delta against the last frame
 * sent; downstream has one queued frame and at most one pending output/settlement.
 * A slow or disconnected reader cannot retain an unbounded token/event queue.
 * No stream path ever submits work. */
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
        let seq = 0;
        let sent: Sent | null = null;
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
            const encoded = encodeOutput(
              ++seq,
              sent,
              current.output,
              (current.toolApprovals ?? []).map((card) => ({
                type: "data-tool-approval",
                id: card.id,
                data: card,
              })),
            );
            sent = encoded.sent;
            controller.enqueue(encoded.frame);
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
