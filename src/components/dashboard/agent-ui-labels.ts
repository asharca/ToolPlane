"use client";

import { useTranslations } from "next-intl";
import { useMemo } from "react";

/** Localized copy for the vendored agent components, which default to English. */
export function useAgentUiLabels() {
  const ui = useTranslations("console.agentUi");
  const work = useTranslations("console.work");
  const common = useTranslations("console.common");
  const nativeUi = useTranslations("console.work.nativeUi");

  return useMemo(
    () => ({
      toolResult: {
        running: work("toolRunning"),
        success: work("toolCompleted"),
        error: work("toolFailed"),
        cancelled: work("statusCancelled"),
        copy: ui("copyResult"),
        copied: common("copied"),
        retry: ui("runAgain"),
      },
      composer: {
        stopGenerating: ui("stopGenerating"),
        sendPrompt: ui("sendPrompt"),
      },
      codeBlock: {
        streaming: ui("codeWriting"),
        complete: ui("codeReady"),
        copy: common("copy"),
        copied: common("copied"),
      },
      scroller: {
        emptyMessage: ui("messageLabel"),
        goToMessage: (sender: string, index: number, total: number) =>
          ui("goToMessage", {
            sender:
              sender === "user"
                ? ui("senderUser")
                : sender === "assistant"
                  ? ui("senderAssistant")
                  : sender,
            index,
            total,
          }),
      },
      todoList: {
        pending: nativeUi("todoStatus.pending"),
        "in-progress": nativeUi("todoStatus.in_progress"),
        completed: nativeUi("todoStatus.completed"),
        cancelled: nativeUi("todoStatus.abandoned"),
        ariaLabel: ui("tasksLabel"),
        empty: ui("tasksEmpty"),
        completedSummary: (completed: number, total: number) =>
          ui("tasksCompleted", { completed, total }),
      },
    }),
    [ui, work, common, nativeUi],
  );
}
