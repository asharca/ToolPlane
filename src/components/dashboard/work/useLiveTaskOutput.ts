"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import type {
  LiveTaskOutput,
  LiveTaskSnapshotEvent,
  LiveTaskSettledEvent,
} from "@/lib/agents/execution/live-output-types";

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
  connection: LiveOutputConnection;
};

const MAX_FRAME_LENGTH = 2 * 1024 * 1024;

/** Observation only: reconnects replace snapshots and never submit execution. */
export function useLiveTaskOutput({
  url,
  paused = false,
  onSettled,
  onRevoked,
}: {
  url: string | null;
  paused?: boolean;
  onSettled?: (taskId: string) => void;
  onRevoked?: () => void;
}) {
  const [state, setState] = useState<StreamState>({
    scope: url,
    output: null,
    connection: "connecting",
  });
  const settled = useEffectEvent((taskId: string) => onSettled?.(taskId));
  const revoked = useEffectEvent(() => onRevoked?.());
  const deniedScope = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    let denied = false;
    let controller: AbortController | undefined;
    let reconnectTimer: number | undefined;
    let watchdog: number | undefined;
    let failures = 0;
    const update = (patch: Partial<StreamState>) => {
      if (!alive) return;
      setState((previous) => ({
        scope: url,
        output: previous.scope === url ? previous.output : null,
        connection: "connecting",
        ...patch,
      }));
    };
    if (url && deniedScope.current === url) {
      update({ output: null, connection: "revoked" });
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
      update({ output: null, connection: "revoked" });
      controller?.abort();
      revoked();
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
          value.output !== null &&
          (!value.output ||
            typeof value.output.taskId !== "string" ||
            typeof value.output.text !== "string" ||
            !Array.isArray(value.output.activities) ||
            typeof value.output.active !== "boolean" ||
            typeof value.output.done !== "boolean")
        ) {
          throw new Error("Invalid live output snapshot");
        }
        failures = 0;
        // Every event is authoritative, including a null snapshot after reconnect.
        update({ output: value.output, connection: "live" });
      } else if (event === "settled") {
        const value = JSON.parse(data.join("\n")) as LiveTaskSettledEvent;
        if (typeof value.taskId === "string") settled(value.taskId);
      }
    };
    const connect = async () => {
      if (!alive || denied) return;
      update({ connection: failures ? "reconnecting" : "connecting" });
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
    : { scope: url, output: null, connection: "connecting" as const };
}
