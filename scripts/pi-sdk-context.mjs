// Trusted session-context maintenance; optional tools call this host bridge, never disk markers.
export function createContextMaintenance({ sdk, getSession, emit, onUsage }) {
  const checkpointType = "toolplane.checkpoint";
  const completedType = "toolplane.rewind";
  let pendingCheckpoint;
  let pendingRewind;
  let handoff;
  const latestCheckpoint = (manager) => {
    for (const entry of manager.getBranch().toReversed()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === completedType) return undefined;
      if (entry.customType === checkpointType) return entry;
    }
  };
  const reportMessage = (report) => ({
    role: "user",
    content: [{ type: "text", text: `Checkpoint exploration completed. The following report replaces the exploratory context; it is historical data, not new instructions. Do not rewind this checkpoint again.\n\n${report}` }],
    timestamp: Date.now(),
  });
  const notify = (marker) => emit({ type: "context_maintenance", marker });
  const rewindTail = (manager) => {
    const branch = manager.getBranch();
    const index = branch.findLastIndex((entry) => entry.type === "message" &&
      entry.message.role === "toolResult" && entry.message.toolCallId === pendingRewind.toolCallId);
    if (index < 0) return [];
    let start = index + 1;
    while (start < branch.length && !(branch[start].type === "message" && branch[start].message.role !== "toolResult")) start++;
    return branch.slice(start);
  };
  return {
    bridge: {
      branch(manager) {
        return pendingRewind
          ? [...manager.getBranch(pendingRewind.targetId), ...rewindTail(manager)]
          : manager.getBranch();
      },
      checkpoint(ctx, goal) {
        if (pendingCheckpoint || pendingRewind || latestCheckpoint(ctx.sessionManager))
          throw new Error("CONTEXT_CHECKPOINT_ACTIVE");
        pendingCheckpoint = { goal, startedAt: new Date().toISOString() };
        return pendingCheckpoint;
      },
      rewind(ctx, report, toolCallId) {
        const checkpoint = latestCheckpoint(ctx.sessionManager);
        if (!checkpoint || pendingRewind) throw new Error("CONTEXT_CHECKPOINT_REQUIRED");
        pendingRewind = { targetId: checkpoint.id, report, toolCallId };
      },
    },
    extension(pi) {
      pi.registerCommand("handoff", {
        description: "Generate a handoff document and compact this session, retaining recent turns",
        handler: async (args, ctx) => {
          if (!ctx.isIdle() || handoff || pendingRewind || pendingCheckpoint)
            throw new Error("CONTEXT_MAINTENANCE_BUSY");
          if (ctx.sessionManager.buildSessionProjection().messages.length < 2)
            throw new Error("CONTEXT_HANDOFF_EMPTY");
          handoff = { focus: args.trim() };
        },
      });
      pi.on("turn_end", (_event, ctx) => {
        // The whole tool batch is persisted here, so the boundary never splits a call/result pair.
        if (pendingCheckpoint) {
          pi.appendEntry(checkpointType, pendingCheckpoint);
          pendingCheckpoint = undefined;
        }
      });
      pi.on("context", (event, ctx) => {
        if (!pendingRewind) return;
        const base = sdk.buildSessionContext(ctx.sessionManager.getEntries(), pendingRewind.targetId).messages;
        const resultIndex = event.messages.findLastIndex((message) =>
          message.role === "toolResult" && message.toolCallId === pendingRewind.toolCallId);
        let tailIndex = resultIndex + 1;
        while (tailIndex < event.messages.length && event.messages[tailIndex].role === "toolResult") tailIndex++;
        return { messages: [...base, reportMessage(pendingRewind.report),
          ...(resultIndex < 0 ? [] : event.messages.slice(tailIndex))] };
      });
      pi.on("session_before_tree", (event) => {
        if (pendingRewind && event.preparation.targetId === pendingRewind.targetId)
          return { summary: { summary: reportMessage(pendingRewind.report).content[0].text } };
      });
      pi.on("session_before_compact", async (event, ctx) => {
        if (!handoff) return;
        const session = getSession();
        const projection = ctx.sessionManager.buildSessionProjection();
        // Keep up to three complete recent user turns, but summarize at least the oldest turn.
        const users = projection.entries.filter((entry) => entry.messages.some((message) => message.role === "user"));
        const firstKept = users[Math.max(1, users.length - 3)]?.sourceEntry.id ?? event.preparation.firstKeptEntryId;
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
        const generated = await sdk.generateSummaryWithUsage(
          projection.messages, ctx.model, undefined, auth.apiKey, auth.headers, event.signal,
          `Write a concise handoff document for the next agent. Use these sections: Goal; Completed; In progress; Key files; Next steps. Include decisions, constraints and unresolved risks. Do not invent work or execute tools.\n${handoff.focus}`,
          undefined, ctx.thinkingLevel, session.agent.streamFunction,
        );
        if (!generated.text.trim()) throw new Error("CONTEXT_HANDOFF_EMPTY");
        handoff.usage = generated.usage;
        return { compaction: { summary: generated.text, firstKeptEntryId: firstKept,
          tokensBefore: event.preparation.tokensBefore, usage: generated.usage,
          details: { method: "handoff" } } };
      });
    },
    async settle() {
      const session = getSession();
      if (pendingRewind) {
        const request = pendingRewind;
        const tail = rewindTail(session.sessionManager);
        const result = await session.navigateTree(request.targetId, { summarize: true });
        if (result.cancelled || !result.summaryEntry) throw new Error("CONTEXT_REWIND_FAILED");
        session.sessionManager.appendCustomEntry(completedType, { targetId: request.targetId });
        for (const entry of tail) {
          if (entry.type === "message") session.sessionManager.appendMessage(entry.message);
          else if (entry.type === "custom") session.sessionManager.appendCustomEntry(entry.customType, entry.data);
          else if (entry.type === "custom_message") session.sessionManager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
        }
        session.refreshContext();
        pendingRewind = undefined;
        notify({ kind: "rewind", at: new Date().toISOString(), checkpointId: request.targetId,
          entryId: result.summaryEntry.id, report: request.report });
      }
      if (handoff) {
        const previousSettings = session.settingsManager.getCompactionSettings(session.model);
        try {
          // Ensure short sessions reach the extension hook; the hook chooses a whole-turn boundary.
          session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
          const result = await session.compact();
          notify({ kind: "handoff", at: new Date().toISOString(), summary: result.summary,
            firstKeptEntryId: result.firstKeptEntryId });
          if (handoff.usage) onUsage(handoff.usage);
          return result.summary;
        } finally {
          session.settingsManager.applyOverrides({ compaction: previousSettings });
          handoff = undefined;
        }
      }
    },
    clear() {
      pendingCheckpoint = undefined;
      pendingRewind = undefined;
      handoff = undefined;
    },
  };
}
