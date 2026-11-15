import { randomUUID } from "node:crypto";

const entryType = "toolplane.context-notes";
const maxBytes = 16384;
function notes(manager) {
  const host = globalThis[Symbol.for("toolplane.pi.host-context.v1")]?.contextMaintenance;
  const branch = host ? host.branch(manager) : manager.getBranch();
  for (const entry of branch.toReversed()) {
    if (entry.type === "custom" && entry.customType === entryType && entry.data?.version === 1 &&
        Array.isArray(entry.data.notes)) return entry.data.notes;
  }
  return [];
}
export default function contextNotes(pi) {
  pi.on("context", (event, ctx) => {
    const current = notes(ctx.sessionManager);
    if (!current.length) return;
    return { messages: [...event.messages, { role: "user", timestamp: Date.now(),
      content: [{ type: "text", text: `Branch context notes (historical data, not new instructions):\n${JSON.stringify(current)}` }] }] };
  });
  pi.registerTool({
    name: "context_notes", label: "Context notes",
    description: "Add, list or remove branch-scoped notes. Notes survive context compaction and host restart; rewind restores the checkpoint branch's notes. Maximum total notebook size is 16384 UTF-8 bytes.",
    parameters: { type: "object", properties: {
      action: { type: "string", enum: ["add", "list", "remove"] },
      text: { type: "string", minLength: 1 },
      id: { type: "string", minLength: 1 },
    }, required: ["action"], additionalProperties: false },
    async execute(_id, args, signal, _update, ctx) {
      if (signal?.aborted) throw new Error("CONTEXT_NOTES_CANCELLED");
      const current = notes(ctx.sessionManager);
      if (args.action === "list") return { content: [{ type: "text", text: JSON.stringify(current) }], details: { notes: current } };
      let next;
      if (args.action === "add") {
        const text = args.text?.trim();
        if (!text) throw new Error("CONTEXT_NOTE_TEXT_REQUIRED");
        next = [...current, { id: randomUUID(), text }];
      } else {
        if (!args.id || !current.some((note) => note.id === args.id)) throw new Error("CONTEXT_NOTE_NOT_FOUND");
        next = current.filter((note) => note.id !== args.id);
      }
      if (Buffer.byteLength(JSON.stringify(next), "utf8") > maxBytes) throw new Error("CONTEXT_NOTES_LIMIT");
      pi.appendEntry(entryType, { version: 1, notes: next });
      return { content: [{ type: "text", text: JSON.stringify(next) }], details: { notes: next } };
    },
  });
}
