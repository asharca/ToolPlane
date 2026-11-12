// @vitest-environment node
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { db } from "@/lib/db";
import type { AgentRevisionConfig } from "@/lib/agents/revision-types";
import { isolatedPi } from "@/lib/agents/evolution/isolation";

// Opt in with the real immutable Pi capture image and Docker available. Only the
// external model HTTP boundary is controlled; SDK sessions and bash are real.
describe.skipIf(process.env.TOOLPLANE_TEST_NATIVE_EVOLUTION !== "1")(
  "real isolated evolution native requirements",
  () => {
    let workspaceId: string | undefined;
    let userId: string | undefined;
    let config: AgentRevisionConfig;
    let mode: "execute" | "claim-only" = "execute";
    let observedToolResult = false;
    let modelRequests = 0;
    const requestSchema = z
      .object({
        model: z.string(),
        messages: z.array(
          z
            .object({ role: z.string(), content: z.unknown().optional() })
            .passthrough(),
        ),
      })
      .passthrough();
    const server = createServer((req, res) => {
      void (async () => {
        let text = "";
        for await (const chunk of req) text += chunk.toString();
        const request = requestSchema.parse(JSON.parse(text));
        modelRequests++;
        const toolMessage = request.messages.find(
          (message) => message.role === "tool",
        );
        if (
          toolMessage &&
          JSON.stringify(toolMessage.content).includes("EVOLUTION_NATIVE_OK")
        )
          observedToolResult = true;
        const callBash = mode === "execute" && !toolMessage;
        const delta = callBash
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_native_bash",
                  type: "function",
                  function: {
                    name: "bash",
                    arguments: JSON.stringify({
                      command: "printf EVOLUTION_NATIVE_OK",
                    }),
                  },
                },
              ],
            }
          : {
              role: "assistant",
              content:
                mode === "claim-only" || observedToolResult
                  ? "EVOLUTION_NATIVE_OK"
                  : "TOOL_RESULT_MISSING",
            };
        const chunk = {
          id: `fixture-${modelRequests}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: request.model,
          choices: [{ index: 0, delta, finish_reason: null }],
        };
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        res.write(
          `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: callBash ? "tool_calls" : "stop" }], usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 } })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
      })().catch(() => {
        if (!res.headersSent)
          res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: "CONTROLLED_MODEL_FIXTURE_FAILED" },
          }),
        );
      });
    });
    beforeAll(async () => {
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Model fixture did not bind TCP");
      const stamp = randomUUID();
      userId = (
        await db.user.create({
          data: {
            email: `native-evolution-${stamp}@example.invalid`,
            passwordHash: "fixture",
          },
        })
      ).id;
      workspaceId = (
        await db.workspace.create({
          data: {
            name: "Native evolution regression",
            slug: `native-evolution-${stamp}`,
            ownerId: userId,
          },
        })
      ).id;
      const provider = await db.modelProvider.create({
        data: {
          workspaceId,
          name: "Controlled native regression",
          format: "openai",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: `fixture-key-${stamp}`,
        },
      });
      config = {
        schemaVersion: 1,
        runtimeKind: "pi-sdk",
        systemPrompt: "Follow the supplied task using the enabled tools.",
        providerId: provider.id,
        model: "native-evolution-fixture",
        modelProviderIds: [],
        maxSteps: 5,
        disabledBuiltinTools: [],
        sandboxTemplateId: null,
        externalSandboxes: [],
        environment: {
          kind: "docker",
          image: `fixture@sha256:${"a".repeat(64)}`,
          network: "isolated",
          piVersion: "0.87.1",
          initialSnapshot: null,
          resourceLimits: { memoryBytes: 536870912, cpus: 1, pidsLimit: 128 },
          credentialReferences: [],
        },
        skills: [],
        knowledgeBaseIds: [],
        packages: [],
        mcpGrants: [],
        a2a: {
          inboundEnabled: false,
          outboundEnabled: false,
          policy: { schemaVersion: 1, targets: [] },
        },
      };
    });
    afterAll(async () => {
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      if (workspaceId)
        await db.workspace.delete({ where: { id: workspaceId } });
      if (userId) await db.user.delete({ where: { id: userId } });
      await db.$disconnect();
    });
    it("executes required native bash with no recording and receives its actual output in the next provider request", async () => {
      if (!workspaceId) throw new Error("Workspace fixture missing");
      mode = "execute";
      observedToolResult = false;
      modelRequests = 0;
      let checks = 0;
      let charges = 0;
      const result = await isolatedPi({
        workspaceId,
        config,
        prompt:
          "Use bash to run printf EVOLUTION_NATIVE_OK, then return the actual tool output.",
        recordedTools: [],
        requiredTools: ["bash"],
        beforeRequest: async () => {
          checks++;
        },
        charge: async () => {
          charges++;
        },
      });
      expect(result).toMatchObject({
        text: "EVOLUTION_NATIVE_OK",
        failed: false,
      });
      expect(result.executionImageId).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(observedToolResult).toBe(true);
      expect(modelRequests).toBe(2);
      expect(checks).toBe(2);
      expect(charges).toBe(2);
      expect(result.usage.inputTokens).toBeGreaterThan(0);
    }, 360_000);
    it("rejects a model merely printing the expected output without calling required native bash", async () => {
      if (!workspaceId) throw new Error("Workspace fixture missing");
      mode = "claim-only";
      observedToolResult = false;
      modelRequests = 0;
      let checks = 0;
      let charges = 0;
      const result = await isolatedPi({
        workspaceId,
        config,
        prompt: "Return EVOLUTION_NATIVE_OK.",
        recordedTools: [],
        requiredTools: ["bash"],
        beforeRequest: async () => {
          checks++;
        },
        charge: async () => {
          charges++;
        },
      });
      expect(result).toMatchObject({
        text: "EVOLUTION_NATIVE_OK",
        failed: true,
        failureCode: "EVALUATION_UNSUPPORTED_CAPABILITY",
      });
      expect(observedToolResult).toBe(false);
      expect(modelRequests).toBe(1);
      expect(checks).toBe(1);
      expect(charges).toBe(1);
    }, 360_000);
  },
);
