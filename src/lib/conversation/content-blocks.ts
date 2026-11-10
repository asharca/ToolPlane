export type ToolBlockStatus =
  | "running"
  | "awaiting"
  | "succeeded"
  | "failed"
  | "cancelled";

export type ContentStep =
  | { kind: "thinking"; id: string; text: string; streaming: boolean }
  | {
      kind: "tool";
      id: string;
      toolCallId: string;
      toolName: string;
      status: ToolBlockStatus;
      input?: unknown;
      output?: unknown;
      errorText?: string;
      durationMs?: number;
      /** Failed outside the model's view (e.g. a confirmed execution receipt). */
      platformFailure?: boolean;
    }
  | {
      kind: "data";
      id: string;
      partIndex: number;
      type: `data-${string}`;
      data: unknown;
    };

export type ContentBlock =
  | { kind: "text"; id: string; text: string; streaming: boolean }
  | {
      kind: "process";
      id: string;
      status: "working" | "complete" | "failed" | "cancelled";
      steps: ContentStep[];
    }
  | {
      kind: "file";
      id: string;
      partIndex: number;
      url: string;
      filename?: string;
      mediaType: string;
    };

type ProcessStatus = Extract<ContentBlock, { kind: "process" }>["status"];

function dataStatus(data: unknown): ToolBlockStatus | undefined {
  if (!data || typeof data !== "object") return;
  const value = data as Record<string, unknown>;
  if (
    value.isError === true ||
    value.status === "failed" ||
    value.status === "timed_out"
  )
    return "failed";
  if (value.status === "cancelled" || value.result === "cancelled")
    return "cancelled";
  if (value.status === "running" || value.status === "working")
    return "running";
  return;
}

/** Recalculate after display-only receipt overrides or appended process steps. */
export function contentProcessStatus(
  steps: readonly ContentStep[],
  streaming: boolean,
  current = streaming,
): ProcessStatus {
  let cancelled = false;
  let pending = false;
  let awaiting = false;
  for (const step of steps) {
    const status =
      step.kind === "tool"
        ? step.status
        : step.kind === "data"
          ? dataStatus(step.data)
          : undefined;
    // Tool errors are results the model reads and handles (including a subagent's
    // tool); only runtime or platform-level failures fail the whole process.
    const modelResult =
      (step.kind === "tool" && !step.platformFailure) ||
      (step.kind === "data" &&
        (step.data as { type?: unknown } | null)?.type === "tool");
    if (status === "failed" && !modelResult) return "failed";
    if (status === "cancelled") cancelled = true;
    if (status === "running" || status === "awaiting") pending = true;
    if (status === "awaiting") awaiting = true;
  }
  if (awaiting || (streaming && (pending || (current && !cancelled))))
    return "working";
  if (cancelled || pending) return "cancelled";
  return "complete";
}

function toolStatus(state: unknown, streaming: boolean): ToolBlockStatus {
  switch (state) {
    case "approval-requested":
      return "awaiting";
    case "output-available":
      return "succeeded";
    case "output-error":
    case "output-denied":
      return "failed";
    default:
      return streaming ? "running" : "cancelled";
  }
}

/**
 * Display-only adaptation: never mutate the stored UI-message parts. Text and
 * attachments delimit adjacent process steps; unselected metadata is ignored.
 * IDs follow immutable part slots, not growing content. Only the trailing live
 * text/thinking slot streams; stopped in-flight tools become cancelled.
 */
export function toContentBlocks(
  messageId: string,
  parts: readonly { type: string; [key: string]: unknown }[],
  options: {
    streaming: boolean;
    processDataTypes?: readonly `data-${string}`[];
  },
): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const appendStep = (step: ContentStep, partIndex: number) => {
    const previous = blocks.at(-1);
    if (previous?.kind === "process") previous.steps.push(step);
    else
      blocks.push({
        kind: "process",
        id: `${messageId}:process:${partIndex}`,
        status: "complete",
        steps: [step],
      });
  };

  parts.forEach((part, partIndex) => {
    const id = `${messageId}:part:${partIndex}`;
    if (part.type === "text") {
      // Empty text slots still delimit process groups and retain their identity.
      blocks.push({
        kind: "text",
        id,
        text: typeof part.text === "string" ? part.text : "",
        streaming: options.streaming && part.state !== "done",
      });
      return;
    }
    if (part.type === "reasoning") {
      appendStep(
        {
          kind: "thinking",
          id,
          text: typeof part.text === "string" ? part.text : "",
          streaming: options.streaming && part.state !== "done",
        },
        partIndex,
      );
      return;
    }
    if (part.type === "dynamic-tool" || part.type.startsWith("tool-")) {
      const toolCallId =
        typeof part.toolCallId === "string" ? part.toolCallId : id;
      appendStep(
        {
          kind: "tool",
          id: `${id}:tool:${toolCallId}`,
          toolCallId,
          toolName:
            typeof part.toolName === "string"
              ? part.toolName
              : part.type === "dynamic-tool"
                ? "tool"
                : part.type.slice(5),
          status:
            part.workCancelled === true
              ? "cancelled"
              : toolStatus(part.state, options.streaming),
          input: part.input,
          output: part.output,
          durationMs:
            typeof part.durationMs === "number" ? part.durationMs : undefined,
          errorText:
            typeof part.errorText === "string" ? part.errorText : undefined,
        },
        partIndex,
      );
      return;
    }
    if (
      part.type.startsWith("data-") &&
      options.processDataTypes?.includes(part.type as `data-${string}`)
    ) {
      appendStep(
        {
          kind: "data",
          id,
          partIndex,
          type: part.type as `data-${string}`,
          data: part.data,
        },
        partIndex,
      );
      return;
    }
    if (part.type === "file" || part.type === "image") {
      const url = part.type === "image" ? part.image : part.url;
      if (typeof url !== "string") return;
      blocks.push({
        kind: "file",
        id,
        partIndex,
        url,
        filename: typeof part.filename === "string" ? part.filename : undefined,
        mediaType:
          typeof part.mediaType === "string"
            ? part.mediaType
            : typeof part.mimeType === "string"
              ? part.mimeType
              : part.type === "image"
                ? "image/*"
                : "application/octet-stream",
      });
    }
  });

  blocks.forEach((block, index) => {
    const last = index === blocks.length - 1;
    if (block.kind === "text") block.streaming &&= last;
    if (block.kind !== "process") return;
    block.steps.forEach((step, stepIndex) => {
      if (step.kind === "thinking")
        step.streaming &&= last && stepIndex === block.steps.length - 1;
    });
    block.status = contentProcessStatus(block.steps, options.streaming, last);
  });
  return blocks;
}

/** Work's persisted parts and live activities share this display-only adapter.
 * Keep every source slot, including ignored metadata, so streamed IDs stay stable.
 */
export function workContentParts(
  parts: readonly { type: string; [key: string]: unknown }[],
  streaming: boolean,
): { type: string; [key: string]: unknown }[] {
  return parts.map((part) => {
    const reasoning = part.type === "reasoning";
    const status =
      !streaming && part.status === "running"
        ? reasoning
          ? "completed"
          : "cancelled"
        : part.status;
    if (part.source)
      return {
        type: "data-subagent-activity",
        data: { ...part, status, type: reasoning ? "reasoning" : "tool" },
      };
    if (part.type === "hook-activity" || part.type === "data-hook-activity")
      return { type: "data-hook-activity", data: part.data };
    if (reasoning)
      return { ...part, state: status === "running" ? "streaming" : "done" };
    if (part.type === "work-tool" || part.type === "tool")
      return {
        ...part,
        type: "dynamic-tool",
        toolName:
          part.deploymentName && part.originalToolName
            ? `${part.deploymentName} · ${part.originalToolName}`
            : (part.originalToolName ?? part.toolName ?? "Tool"),
        state:
          part.isError || status === "failed"
            ? "output-error"
            : status === "cancelled"
              ? "input-available"
              : status === "running"
                ? "input-streaming"
                : "output-available",
        // Explicit cancellation also applies while the rest of the turn streams.
        workCancelled: status === "cancelled",
      };
    if (
      (part.type === "work-runtime" || part.type === "runtime") &&
      (status === "failed" || status === "cancelled")
    )
      return { type: "data-work-runtime", data: { ...part, status } };
    if (part.type === "text" && !part.reference) return part;
    return { type: "work-metadata" };
  });
}

/** Live Work output streams text separately from activities; each activity
 * records the text length when it began, so the reply can be read in order.
 */
export function interleaveLiveText<
  T extends { type: string; textOffset?: number },
>(
  activities: readonly T[],
  text: string,
): Array<T | { type: "text"; text: string }> {
  const parts: Array<T | { type: "text"; text: string }> = [];
  let cursor = 0;
  for (const activity of activities) {
    const offset =
      typeof activity.textOffset === "number" &&
      Number.isFinite(activity.textOffset)
        ? Math.min(Math.max(activity.textOffset, cursor), text.length)
        : cursor;
    const segment = text.slice(cursor, offset);
    if (segment.trim()) parts.push({ type: "text", text: segment });
    cursor = offset;
    parts.push(activity);
  }
  const rest = text.slice(cursor);
  if (rest.trim()) parts.push({ type: "text", text: rest });
  return parts;
}

export function formatContentDuration(
  durationMs: number | undefined,
): string | null {
  if (
    durationMs === undefined ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  )
    return null;
  if (durationMs < 1_000) return `${Math.round(durationMs)} ms`;
  const seconds = durationMs / 1_000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
}
