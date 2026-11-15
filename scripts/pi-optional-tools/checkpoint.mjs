export default function checkpoint(pi) {
  pi.registerTool({
    name: "checkpoint", label: "Checkpoint",
    description: "Mark the current conversation tree before exploring. Only one checkpoint may be active. This does not snapshot or restore files. Finish exploration with rewind(report).",
    parameters: { type: "object", properties: { goal: { type: "string", minLength: 1, maxLength: 4000 } }, required: ["goal"], additionalProperties: false },
    async execute(_id, args, _signal, _update, ctx) {
      const host = globalThis[Symbol.for("toolplane.pi.host-context.v1")]?.contextMaintenance;
      if (!host) throw new Error("CONTEXT_HOST_REQUIRED");
      const details = host.checkpoint(ctx, args.goal);
      return { content: [{ type: "text", text: `Checkpoint: ${args.goal}\nFinish exploration and call rewind with your findings.` }], details };
    },
  });
}
