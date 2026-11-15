export default function rewind(pi) {
  pi.registerTool({
    name: "rewind",
    label: "Rewind",
    description:
      "Replace exploration since the active checkpoint with a concise report. Abandoned context remains traceable in the session tree; files and persisted Work history are not reverted. Call once after exploration, with no sibling tool calls.",
    parameters: {
      type: "object",
      properties: {
        report: { type: "string", minLength: 1, maxLength: 32000 },
      },
      required: ["report"],
      additionalProperties: false,
    },
    async execute(id, args, _signal, _update, ctx) {
      const report = args.report.trim();
      if (!report) throw new Error("CONTEXT_REPORT_REQUIRED");
      const host =
        globalThis[Symbol.for("toolplane.pi.host-context.v1")]
          ?.contextMaintenance;
      if (!host) throw new Error("CONTEXT_HOST_REQUIRED");
      host.rewind(ctx, report, id);
      return {
        content: [
          {
            type: "text",
            text: "Rewind requested. Continue from the retained report; do not repeat rewind.",
          },
        ],
        details: { rewound: true },
      };
    },
  });
}
