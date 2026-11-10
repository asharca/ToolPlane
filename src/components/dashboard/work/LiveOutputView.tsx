"use client";

import { useTranslations } from "next-intl";
import type { LiveTaskOutput } from "@/lib/agents/execution/live-output-types";
import { StreamingResponse } from "@/components/agents/streaming-response";
import { WorkContentBlocks } from "@/components/dashboard/ConversationContentBlocks";
import { interleaveLiveText } from "@/lib/conversation/content-blocks";
import type { LiveOutputConnection } from "./useLiveTaskOutput";

const stageKeys = {
  queued: "executionQueued",
  preparing: "executionPreparing",
  "waiting-model": "executionWaitingModel",
  generating: "executionGenerating",
  "tool-running": "executionToolRunning",
} as const;

export function LiveOutputStatus({
  connection,
}: {
  connection: LiveOutputConnection;
}) {
  const t = useTranslations("console.liveOutput");
  return (
    <p role="status" className="text-xs text-muted-foreground">
      {t(connection)}
    </p>
  );
}

/** The same activity and tool primitives as Work, without native dialog authority. */
export function LiveOutputView({
  output,
  hideText = false,
}: {
  output: LiveTaskOutput;
  hideText?: boolean;
}) {
  const t = useTranslations("console.work");
  const liveT = useTranslations("console.liveOutput");
  const active = output.active && !output.done;
  // Tool errors are results the model handles; only the runtime outcome fails a run.
  const failed = output.activities.some(
    (activity) => activity.type === "runtime" && activity.status === "failed",
  );
  const stage = output.executionStage
    ? t(stageKeys[output.executionStage])
    : t("thinking");
  return (
    <div
      className="min-w-0 space-y-3"
      data-message-id={`live-${output.taskId}`}
      aria-busy={active || undefined}
    >
      <StreamingResponse
        status={active ? "streaming" : failed ? "error" : "complete"}
        copyText={!hideText ? output.text : undefined}
        announce={false}
      >
        <WorkContentBlocks
          messageId={`live-${output.taskId}`}
          parts={
            hideText
              ? output.activities
              : interleaveLiveText(output.activities, output.text)
          }
          streaming={active}
          activeLabel={stage}
        />
      </StreamingResponse>
      {!hideText && output.truncated ? (
        <p className="text-xs text-muted-foreground">{liveT("truncated")}</p>
      ) : null}
    </div>
  );
}
