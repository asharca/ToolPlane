import { assert } from "vitest";
import type {
  LiveTaskDeltaEvent,
  LiveTaskOutput,
  LiveTaskSnapshotEvent,
} from "@/lib/agents/execution/live-output-types";

export type LiveOutputView = {
  output: LiveTaskOutput | null;
  apply(event: string | undefined, data: unknown): LiveTaskOutput | null;
};
/** Reconstructs observed output from one connection's snapshot and delta frames, like the browser hook. */
export function liveOutputView(): LiveOutputView {
  let seq: number | null = null;
  const view: LiveOutputView = {
    output: null,
    apply(event: string | undefined, data: unknown) {
      if (event === "snapshot") {
        const snapshot = data as LiveTaskSnapshotEvent;
        seq = snapshot.seq;
        view.output = snapshot.output;
      } else if (event === "delta") {
        const delta = data as LiveTaskDeltaEvent;
        const previous = view.output;
        assert(seq !== null && delta.seq === seq + 1, "delta out of sequence");
        assert(previous?.taskId === delta.taskId, "delta for another task");
        seq = delta.seq;
        const byId = new Map(
          previous.activities.map((item) => [item.id, item]),
        );
        for (const item of delta.activities ?? []) byId.set(item.id, item);
        view.output = {
          ...(delta.fields ?? previous),
          text:
            delta.text === undefined
              ? previous.text
              : previous.text.slice(0, delta.textAt) + delta.text,
          activities: (
            delta.activityIds ?? previous.activities.map((item) => item.id)
          ).flatMap((id) => {
            const item = byId.get(id);
            assert(item, `delta references unknown activity ${id}`);
            return [item];
          }),
        };
      }
      return view.output;
    },
  };
  return view;
}
