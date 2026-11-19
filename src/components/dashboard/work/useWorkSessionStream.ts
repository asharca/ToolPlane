"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseConversationBudgetWarning } from "@/components/dashboard/ConversationMessage";
import type { BudgetWarning } from "@/lib/agents/budget-warning";
import type { AgentExecutionStage } from "@/lib/agents/execution-stages";
import type { AgentMessageQueue } from "@/lib/agents/execution/message-queue";
import {
  StreamRuleTriggerSchema,
  type StreamRuleTrigger,
} from "@/lib/agents/stream-rules";
import { createWorkCompletionTransition } from "./completion-transition";
import type { WorkActivity } from "./work-types";

function mergeStreamRuleTriggers(
  current: StreamRuleTrigger[],
  incoming: unknown[],
) {
  const triggers = new Map(current.map((trigger) => [trigger.id, trigger]));
  for (const value of incoming) {
    const parsed = StreamRuleTriggerSchema.safeParse(value);
    if (parsed.success) triggers.set(parsed.data.id, parsed.data);
  }
  return [...triggers.values()];
}

const EMPTY_WORK_ACTIVITIES: WorkActivity[] = [];

/** The selected Work session's live turn, read from its SSE output stream. */
export function useWorkSessionStream({
  selectedWorkSessionId,
  selectedStatus,
  creatingMode,
  selectedActive,
  refreshSelected,
  notifyCompletion,
  observeMessageQueue,
}: {
  selectedWorkSessionId: string | null;
  selectedStatus: string | undefined;
  creatingMode: boolean;
  selectedActive: boolean;
  refreshSelected: () => Promise<boolean>;
  notifyCompletion: (workSessionId: string, startedAt: number) => void;
  observeMessageQueue: (queue: AgentMessageQueue) => void;
}) {
  const [streamOutput, setStreamOutput] = useState<{
    workSessionId: string;
    text: string;
    activities: WorkActivity[];
    budgetWarning?: BudgetWarning;
    streamRuleTriggers?: StreamRuleTrigger[];
    startedAt?: number;
    runtimeKind?: string;
    modelName?: string;
    executionStage?: AgentExecutionStage;
  }>({ workSessionId: "", text: "", activities: [] });
  const streamText =
    streamOutput.workSessionId === selectedWorkSessionId
      ? streamOutput.text
      : "";
  const streamActivities =
    streamOutput.workSessionId === selectedWorkSessionId
      ? streamOutput.activities
      : EMPTY_WORK_ACTIVITIES;
  const streamBudgetWarning =
    streamOutput.workSessionId === selectedWorkSessionId
      ? streamOutput.budgetWarning
      : undefined;
  const streamRuleTriggers =
    streamOutput.workSessionId === selectedWorkSessionId
      ? (streamOutput.streamRuleTriggers ?? [])
      : [];
  const streamStartedAt =
    streamOutput.workSessionId === selectedWorkSessionId
      ? streamOutput.startedAt
      : undefined;
  const streamRuntimeKind =
    streamOutput.workSessionId === selectedWorkSessionId
      ? streamOutput.runtimeKind
      : undefined;
  const streamModelName =
    streamOutput.workSessionId === selectedWorkSessionId
      ? streamOutput.modelName
      : undefined;
  const executionStage =
    streamOutput.workSessionId === selectedWorkSessionId
      ? (streamOutput.executionStage ??
        (selectedStatus === "queued" ? "queued" : "preparing"))
      : selectedStatus === "queued"
        ? "queued"
        : "preparing";
  const outputSubscription = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (creatingMode || !selectedWorkSessionId) return;
    return () => {
      outputSubscription.current?.();
      outputSubscription.current = null;
    };
  }, [creatingMode, selectedWorkSessionId]);

  useEffect(() => {
    if (
      !selectedWorkSessionId ||
      creatingMode ||
      !selectedActive ||
      outputSubscription.current ||
      typeof EventSource === "undefined"
    )
      return undefined;

    let disposed = false;
    let finishing = false;
    const completion = createWorkCompletionTransition();
    const source = new EventSource(
      `/api/v1/work-sessions/${encodeURIComponent(selectedWorkSessionId)}/events`,
    );

    const payload = <T>(event: Event): T | null => {
      try {
        return JSON.parse((event as MessageEvent).data) as T;
      } catch {
        return null;
      }
    };
    const finish = async () => {
      if (finishing) return;
      finishing = true;
      source.close();
      const refreshed = await refreshSelected();
      if (!disposed && refreshed) {
        setStreamOutput({
          workSessionId: selectedWorkSessionId,
          text: "",
          activities: [],
        });
      }
      dispose();
    };

    source.addEventListener("snapshot", (event) => {
      const next = payload<{
        text?: string;
        activities?: WorkActivity[];
        budgetWarning?: unknown;
        streamRuleTriggers?: unknown[];
        active?: boolean;
        done?: boolean;
        startedAt?: number;
        runtimeKind?: string;
        modelName?: string;
        executionStage?: AgentExecutionStage;
        messageQueue?: AgentMessageQueue;
      }>(event);
      if (!next) return;
      completion.observe("snapshot", next);
      observeMessageQueue(
        next.messageQueue ?? { messages: [], pendingMessageCount: 0 },
      );
      setStreamOutput({
        workSessionId: selectedWorkSessionId,
        text: next.text ?? "",
        activities: Array.isArray(next.activities) ? next.activities : [],
        streamRuleTriggers: mergeStreamRuleTriggers(
          [],
          Array.isArray(next.streamRuleTriggers) ? next.streamRuleTriggers : [],
        ),
        executionStage: next.executionStage,
        budgetWarning: parseConversationBudgetWarning(next.budgetWarning),
        ...(typeof next.startedAt === "number"
          ? { startedAt: next.startedAt }
          : {}),
        ...(typeof next.runtimeKind === "string"
          ? { runtimeKind: next.runtimeKind }
          : {}),
        ...(typeof next.modelName === "string"
          ? { modelName: next.modelName }
          : {}),
      });
      if (next.done) {
        void finish();
        return;
      }
    });
    source.addEventListener("start", (event) => {
      const next = payload<{
        active?: boolean;
        done?: boolean;
        startedAt?: number;
        runtimeKind?: string;
        modelName?: string;
        executionStage?: AgentExecutionStage;
      }>(event);
      if (next) completion.observe("start", next);
      setStreamOutput({
        workSessionId: selectedWorkSessionId,
        text: "",
        activities: [],
        executionStage: next?.executionStage,
        ...(typeof next?.startedAt === "number"
          ? { startedAt: next.startedAt }
          : {}),
        ...(typeof next?.runtimeKind === "string"
          ? { runtimeKind: next.runtimeKind }
          : {}),
        ...(typeof next?.modelName === "string"
          ? { modelName: next.modelName }
          : {}),
      });
      void refreshSelected();
      observeMessageQueue({ messages: [], pendingMessageCount: 0 });
    });
    source.addEventListener("stream_rule_triggered", (event) => {
      const next = payload<{
        trigger?: unknown;
        streamRuleTriggers?: unknown[];
        startedAt?: number;
      }>(event);
      if (!next) return;
      setStreamOutput((current) => {
        const sameTurn =
          current.workSessionId === selectedWorkSessionId &&
          (next.startedAt === undefined ||
            current.startedAt === next.startedAt);
        return {
          ...(sameTurn
            ? current
            : {
                workSessionId: selectedWorkSessionId,
                text: "",
                activities: [],
                startedAt: next.startedAt,
              }),
          streamRuleTriggers: mergeStreamRuleTriggers(
            sameTurn ? (current.streamRuleTriggers ?? []) : [],
            [
              ...(Array.isArray(next.streamRuleTriggers)
                ? next.streamRuleTriggers
                : []),
              next.trigger,
            ],
          ),
        };
      });
    });
    source.addEventListener("stage", (event) => {
      receiveBudgetWarning(event);
      const next = payload<{
        text: string;
        activities: WorkActivity[];
        executionStage?: AgentExecutionStage;
        messageQueue?: AgentMessageQueue;
      }>(event);
      if (!next) return;
      observeMessageQueue(
        next.messageQueue ?? { messages: [], pendingMessageCount: 0 },
      );
      setStreamOutput((current) => ({
        ...(current.workSessionId === selectedWorkSessionId
          ? current
          : { workSessionId: selectedWorkSessionId }),
        text: next.text,
        activities: next.activities,
        executionStage: next.executionStage,
      }));
      // Stage snapshots also carry consumption boundaries, not just stage labels.
      void refreshSelected();
    });
    source.addEventListener("delta", (event) => {
      receiveBudgetWarning(event);
      const next = payload<{ delta?: string }>(event);
      if (!next?.delta) return;
      setStreamOutput((current) => ({
        workSessionId: selectedWorkSessionId,
        text:
          (current.workSessionId === selectedWorkSessionId
            ? current.text
            : "") + next.delta,
        activities:
          current.workSessionId === selectedWorkSessionId
            ? current.activities
            : [],
        budgetWarning:
          current.workSessionId === selectedWorkSessionId
            ? current.budgetWarning
            : undefined,
        streamRuleTriggers:
          current.workSessionId === selectedWorkSessionId
            ? current.streamRuleTriggers
            : [],
        executionStage:
          current.workSessionId === selectedWorkSessionId
            ? current.executionStage
            : undefined,
        ...(current.workSessionId === selectedWorkSessionId &&
        current.startedAt !== undefined
          ? { startedAt: current.startedAt }
          : {}),
        ...(current.workSessionId === selectedWorkSessionId &&
        current.runtimeKind
          ? { runtimeKind: current.runtimeKind }
          : {}),
        ...(current.workSessionId === selectedWorkSessionId && current.modelName
          ? { modelName: current.modelName }
          : {}),
      }));
    });
    source.addEventListener("activity", (event) => {
      receiveBudgetWarning(event);
      const next = payload<{ activities?: WorkActivity[] }>(event);
      if (!Array.isArray(next?.activities)) return;
      setStreamOutput((current) => ({
        workSessionId: selectedWorkSessionId,
        text:
          current.workSessionId === selectedWorkSessionId ? current.text : "",
        activities: next.activities ?? [],
        budgetWarning:
          current.workSessionId === selectedWorkSessionId
            ? current.budgetWarning
            : undefined,
        streamRuleTriggers:
          current.workSessionId === selectedWorkSessionId
            ? current.streamRuleTriggers
            : [],
        executionStage:
          current.workSessionId === selectedWorkSessionId
            ? current.executionStage
            : undefined,
        ...(current.workSessionId === selectedWorkSessionId &&
        current.startedAt !== undefined
          ? { startedAt: current.startedAt }
          : {}),
        ...(current.workSessionId === selectedWorkSessionId &&
        current.runtimeKind
          ? { runtimeKind: current.runtimeKind }
          : {}),
        ...(current.workSessionId === selectedWorkSessionId && current.modelName
          ? { modelName: current.modelName }
          : {}),
      }));
    });
    const receiveBudgetWarning = (event: Event) => {
      const next = payload<{ budgetWarning?: unknown; data?: unknown }>(event);
      const warning = parseConversationBudgetWarning(
        next?.budgetWarning ??
          (event.type === "data-budget-warning" ? next?.data : undefined),
      );
      if (!warning) return;
      setStreamOutput((current) => {
        const sameSession = current.workSessionId === selectedWorkSessionId;
        if (sameSession && current.budgetWarning?.taskId === warning.taskId)
          return current;
        return {
          ...(sameSession
            ? current
            : {
                workSessionId: selectedWorkSessionId,
                text: "",
                activities: [],
              }),
          budgetWarning: warning,
        };
      });
    };
    source.addEventListener("data-budget-warning", receiveBudgetWarning);
    source.addEventListener("error", () => completion.disconnect());
    source.addEventListener("done", (event) => {
      if (disposed) return;
      receiveBudgetWarning(event);
      const next = payload<{
        active?: boolean;
        done?: boolean;
        startedAt?: number;
      }>(event);
      const startedAt = next ? completion.observe("done", next) : null;
      if (startedAt !== null)
        notifyCompletion(selectedWorkSessionId, startedAt);
      void finish();
    });

    function dispose() {
      disposed = true;
      completion.disconnect();
      source.close();
      if (outputSubscription.current === dispose)
        outputSubscription.current = null;
    }
    // REST status becomes terminal before the coordinator publishes SSE done.
    // Only the stream itself or a selection/unmount may dispose this listener.
    outputSubscription.current = dispose;
  }, [
    creatingMode,
    refreshSelected,
    selectedActive,
    selectedWorkSessionId,
    notifyCompletion,
    observeMessageQueue,
  ]);

  /** A queued retry or edit starts a fresh live turn for this session. */
  const resetStream = useCallback(
    (workSessionId: string) =>
      setStreamOutput({ workSessionId, text: "", activities: [] }),
    [],
  );
  return {
    streamText,
    streamActivities,
    streamBudgetWarning,
    streamRuleTriggers,
    streamStartedAt,
    streamRuntimeKind,
    streamModelName,
    executionStage,
    resetStream,
  };
}
