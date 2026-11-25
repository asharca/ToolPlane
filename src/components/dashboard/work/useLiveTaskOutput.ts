"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import type {
  LiveTaskActivity,
  LiveTaskDeltaEvent,
  LiveTaskOutput,
  LiveTaskSnapshotEvent,
  LiveTaskSettledEvent,
  ToolApprovalDataPart,
} from "@/lib/agents/execution/live-output-types";
import { ToolApprovalDataPartsSchema } from "./ToolApprovalRequest";

export type LiveOutputConnection =
  | "connecting"
  | "live"
  | "disconnected"
  | "reconnecting"
  | "paused"
  | "revoked";

type StreamState = {
  scope: string | null;
  output: LiveTaskOutput | null;
  dataParts: ToolApprovalDataPart[] | null;
  connection: LiveOutputConnection;
};

const MAX_FRAME_LENGTH = 2 * 1024 * 1024;

/** Observation only: reconnects replace snapshots and never submit execution. */
export function useLiveTaskOutput({
  url,
  paused = false,
  onSettled,
  onRevoked,
  onSnapshot,
  onTranscriptChange,
}: {
  url: string | null;
  paused?: boolean;
  onSettled?: (taskId: string) => void;
  onRevoked?: () => void;
  onSnapshot?: (output: LiveTaskOutput | null) => void;
  onTranscriptChange?: () => void;
}) {
  const [state, setState] = useState<StreamState>({
    scope: url,
    output: null,
    dataParts: null,
    connection: "connecting",
  });
  const settled = useEffectEvent((taskId: string) => onSettled?.(taskId));
  const revoked = useEffectEvent(() => onRevoked?.());
  const deniedScope = useRef<string | null>(null);
  const snapshot = useEffectEvent((output: LiveTaskOutput | null) =>
    onSnapshot?.(output),
  );
  const transcriptChanged = useEffectEvent(() => onTranscriptChange?.());

  useEffect(() => {
    let alive = true;
    let denied = false;
    let controller: AbortController | undefined;
    let reconnectTimer: number | undefined;
    let watchdog: number | undefined;
    let failures = 0;
    let previousOutput: LiveTaskOutput | null = null;
    let previousParts: ToolApprovalDataPart[] = [];
    // Last frame applied on this connection; null until its snapshot arrives.
    let seq: number | null = null;
    const update = (patch: Partial<StreamState>) => {
      if (!alive) return;
      setState((previous) => ({
        scope: url,
        output: previous.scope === url ? previous.output : null,
        dataParts: previous.scope === url ? previous.dataParts : null,
        connection: "connecting",
        ...patch,
      }));
    };
    if (url && deniedScope.current === url) {
      update({ output: null, dataParts: null, connection: "revoked" });
      return () => {
        alive = false;
      };
    }
    deniedScope.current = null;
    if (!url || paused) {
      update({ connection: "paused" });
      return () => {
        alive = false;
      };
    }
    const deny = () => {
      denied = true;
      deniedScope.current = url;
      update({ output: null, dataParts: null, connection: "revoked" });
      controller?.abort();
      revoked();
    };
    const isOutput = (output: Partial<LiveTaskOutput> | null | undefined) =>
      Boolean(
        output &&
          typeof output.taskId === "string" &&
          typeof output.active === "boolean" &&
          typeof output.done === "boolean",
      );
    const isActivities = (value: unknown): value is LiveTaskActivity[] =>
      Array.isArray(value) &&
      value.every(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          "id" in item &&
          typeof item.id === "string",
      );
    const accept = (
      next: LiveTaskOutput | null,
      dataParts: ToolApprovalDataPart[],
    ) => {
      failures = 0;
      if (
        next &&
        (next.taskId !== previousOutput?.taskId ||
          next.startedAt !== previousOutput?.startedAt ||
          (previousOutput &&
            (!next.text.startsWith(previousOutput.text) ||
              next.activities.length < previousOutput.activities.length ||
              previousOutput.messageQueue?.messages.some(
                (message) =>
                  !next.messageQueue?.messages.some(
                    (item) => item.id === message.id,
                  ),
              ))))
      ) {
        transcriptChanged();
      }
      previousOutput = next;
      previousParts = dataParts;
      snapshot(next);
      // Every frame is authoritative, including a null snapshot after reconnect.
      update({ output: next, dataParts, connection: "live" });
    };
    // A delta that cannot be applied exactly throws; reconnecting resyncs from a snapshot.
    const applyDelta = (value: LiveTaskDeltaEvent) => {
      const previous = previousOutput;
      if (
        !previous ||
        seq === null ||
        value.seq !== seq + 1 ||
        value.taskId !== previous.taskId
      )
        throw new Error("Live output delta out of sequence");
      seq = value.seq;
      let text = previous.text;
      if (value.text !== undefined) {
        if (
          typeof value.text !== "string" ||
          typeof value.textAt !== "number" ||
          value.textAt < 0 ||
          value.textAt > text.length
        )
          throw new Error("Invalid live output delta");
        text = text.slice(0, value.textAt) + value.text;
      }
      let activities = previous.activities;
      if (value.activities !== undefined || value.activityIds !== undefined) {
        const changed = value.activities ?? [];
        const order = value.activityIds ?? activities.map((item) => item.id);
        if (!isActivities(changed) || !Array.isArray(order))
          throw new Error("Invalid live output delta");
        const byId = new Map(activities.map((item) => [item.id, item]));
        for (const item of changed) byId.set(item.id, item);
        activities = order.map((id) => {
          const item = byId.get(id);
          if (!item) throw new Error("Invalid live output delta");
          return item;
        });
        if (!value.activityIds && byId.size !== activities.length)
          throw new Error("Invalid live output delta");
      }
      if (
        value.fields !== undefined &&
        (!isOutput(value.fields) || value.fields.taskId !== previous.taskId)
      )
        throw new Error("Invalid live output delta");
      accept(
        { ...(value.fields ?? previous), text, activities },
        value.dataParts === undefined
          ? previousParts
          : ToolApprovalDataPartsSchema.parse(value.dataParts),
      );
    };
    const acceptFrame = (frame: string) => {
      let event = "message";
      const data: string[] = [];
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:"))
          data.push(line.slice(5).replace(/^ /, ""));
      }
      if (event === "revoked") {
        deny();
      } else if (event === "snapshot") {
        const value = JSON.parse(data.join("\n")) as LiveTaskSnapshotEvent;
        if (
          typeof value.seq !== "number" ||
          (value.output !== null &&
            (!isOutput(value.output) ||
              typeof value.output.text !== "string" ||
              !isActivities(value.output.activities)))
        ) {
          throw new Error("Invalid live output snapshot");
        }
        seq = value.seq;
        accept(
          value.output,
          ToolApprovalDataPartsSchema.parse(value.dataParts ?? []),
        );
      } else if (event === "delta") {
        applyDelta(JSON.parse(data.join("\n")) as LiveTaskDeltaEvent);
      } else if (event === "settled") {
        const value = JSON.parse(data.join("\n")) as LiveTaskSettledEvent;
        if (typeof value.taskId === "string") settled(value.taskId);
      }
    };
    const connect = async () => {
      if (!alive || denied) return;
      update({ connection: failures ? "reconnecting" : "connecting" });
      seq = null;
      const flight = new AbortController();
      controller = flight;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const armWatchdog = (delay: number) => {
        clearTimeout(watchdog);
        watchdog = window.setTimeout(() => flight.abort(), delay);
      };
      armWatchdog(15_000);
      try {
        const response = await fetch(url, {
          credentials: "same-origin",
          cache: "no-store",
          headers: { Accept: "text/event-stream" },
          signal: flight.signal,
        });
        if (!alive) return;
        if ([401, 403, 404].includes(response.status)) {
          deny();
          return;
        }
        if (
          !response.ok ||
          !response.body ||
          !response.headers.get("content-type")?.includes("text/event-stream")
        ) {
          throw new Error("Live output unavailable");
        }
        update({ connection: "live" });
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (alive && !denied) {
          armWatchdog(45_000);
          const chunk = await reader.read();
          if (!alive || denied) break;
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let boundary = /\r?\n\r?\n/.exec(buffer);
          while (boundary && alive && !denied) {
            if (boundary.index > MAX_FRAME_LENGTH)
              throw new Error("Live output frame too large");
            acceptFrame(buffer.slice(0, boundary.index));
            buffer = buffer.slice(boundary.index + boundary[0].length);
            boundary = /\r?\n\r?\n/.exec(buffer);
          }
          if (buffer.length > MAX_FRAME_LENGTH)
            throw new Error("Live output frame too large");
        }
      } catch {
        // Transport errors recover by reading a fresh snapshot, never resubmitting work.
      } finally {
        clearTimeout(watchdog);
        flight.abort();
        try {
          await reader?.cancel();
        } catch {
          /* Aborted reads are already released. */
        }
        reader?.releaseLock();
        if (controller === flight) controller = undefined;
      }
      if (!alive || denied) return;
      update({ connection: "disconnected" });
      reconnectTimer = window.setTimeout(
        () => {
          reconnectTimer = undefined;
          void connect();
        },
        Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)),
      );
    };
    void connect();
    return () => {
      alive = false;
      clearTimeout(reconnectTimer);
      clearTimeout(watchdog);
      controller?.abort();
    };
  }, [url, paused]);

  // Do not render the previous resource even for the render before effect cleanup.
  return state.scope === url
    ? {
        ...state,
        connection:
          paused && state.connection !== "revoked"
            ? ("paused" as const)
            : state.connection,
      }
    : {
        scope: url,
        output: null,
        dataParts: null,
        connection: "connecting" as const,
      };
}
