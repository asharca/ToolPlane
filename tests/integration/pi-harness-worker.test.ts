// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createLocalRootGrant } from "@/lib/a2a/local-policy";

let workspaceId = "";
let userId = "";
let providerId = "";
const stamp = randomUUID();
beforeAll(async () => {
  userId = (
    await db.user.create({
      data: {
        email: `retired-runtime-${stamp}@test.invalid`,
        passwordHash: "fixture",
      },
    })
  ).id;
  workspaceId = (
    await db.workspace.create({
      data: {
        slug: `retired-runtime-${stamp}`,
        name: "Retained history",
        ownerId: userId,
      },
    })
  ).id;
  providerId = (
    await db.modelProvider.create({
      data: {
        workspaceId,
        name: "Fixture",
        format: "openai",
        baseUrl: "https://never-called.test.invalid",
        apiKey: "fixture",
      },
    })
  ).id;
});
afterAll(async () => {
  if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } });
  if (userId) await db.user.delete({ where: { id: userId } });
});
describe("retired native Harness and legacy execution", () => {
  it.each(["pi", "claude-code", "dsh"])(
    "preserves %s messages but never admits new execution",
    async (runtimeKind) => {
      const deployment = await db.deployment.create({
        data: { workspaceId, source: "config" },
      });
      const sandbox = await db.sandbox.create({
        data: {
          workspaceId,
          deploymentId: deployment.id,
          name: runtimeKind,
          slug: runtimeKind,
          kind: "docker",
          network: "isolated",
        },
      });
      const agent = await db.agent.create({
        data: {
          workspaceId,
          name: runtimeKind,
          slug: runtimeKind,
          runtimeKind,
          providerId,
          model: "fixture",
          a2aInternalEnabled: true,
          a2aInboundEnabled: true,
          a2aOutboundEnabled: true,
          sandboxes: { create: { sandboxId: sandbox.id, isDefault: true } },
        },
      });
      const conversation = await db.conversation.create({
        data: {
          agentId: agent.id,
          messages: {
            create: {
              role: "assistant",
              parts: [{ type: "text", text: "Retained historical response" }],
            },
          },
        },
        include: { messages: true },
      });
      await expect(
        createLocalRootGrant(workspaceId, agent.id, userId),
      ).rejects.toThrow();
      expect(await db.a2AContext.count({ where: { agentId: agent.id } })).toBe(
        0,
      );
      const retained = await db.conversation.findUniqueOrThrow({
        where: { id: conversation.id },
        include: { messages: true },
      });
      expect(retained).toMatchObject({
        agentRevisionId: null,
        legacyRevisionUnresolved: true,
      });
      expect(retained.messages[0].parts).toEqual([
        { type: "text", text: "Retained historical response" },
      ]);
    },
  );
});
