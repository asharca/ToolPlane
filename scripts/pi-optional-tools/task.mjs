const hostKey = Symbol.for("toolplane.pi.host-context.v1");

export default function taskExtension(pi) {
  pi.registerTool({
    name: "task",
    label: "Task",
    description:
      "Run up to eight independent subagents concurrently in this session workspace. Each child uses the same model and enabled tools except task, with isolated conversation history. Waits for every result; child failures do not discard successful results. Children share files, so assign disjoint writes.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        context: { type: "string", maxLength: 100000 },
        tasks: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" },
              description: { type: "string", minLength: 1, maxLength: 240 },
              prompt: { type: "string", minLength: 1, maxLength: 100000 },
            },
            required: ["id", "description", "prompt"],
          },
        },
      },
      required: ["tasks"],
    },
    async execute(toolCallId, args, signal) {
      const run = globalThis[hostKey]?.runTasks;
      if (!run)
        return {
          content: [
            {
              type: "text",
              text: "TASK_HOST_UNAVAILABLE: Subagents require the trusted ToolPlane session host.",
            },
          ],
          isError: true,
          details: { reason: "TASK_HOST_UNAVAILABLE", results: [] },
        };
      return run(toolCallId, args, signal);
    },
  });
}
