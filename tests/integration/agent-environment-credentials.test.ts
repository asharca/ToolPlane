// @vitest-environment node
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { encryptSecretText } from "@/lib/security/secrets";
import {
  assertAgentCredentialName,
  assertAgentEnvironmentCredentialReferences,
} from "@/lib/agents/environment-credentials";

const rollback = new Error("credential fixture rollback");

describe("Agent environment credential reference authorization", () => {
  it("rejects runtime loader and platform-reserved environment names", () => {
    for (const name of [
      "NODE_OPTIONS",
      "TOOLPLANE_RUNTIME_TOKEN",
      "LD_PRELOAD",
      "PATH",
      "BASH_ENV",
      "bad-name",
    ]) {
      expect(() => assertAgentCredentialName(name)).toThrow(
        "AGENT_CREDENTIAL_NAME_INVALID",
      );
    }
    expect(() => assertAgentCredentialName("MY_SERVICE_TOKEN")).not.toThrow();
  });

  it("accepts only exact owned nonrevoked references without selecting secret values", async () => {
    await expect(
      db.$transaction(async (tx) => {
        const stamp = randomUUID();
        const user = await tx.user.create({
          data: {
            email: `agent-credential-${stamp}@test.invalid`,
            passwordHash: "fixture",
          },
        });
        const workspace = await tx.workspace.create({
          data: {
            ownerId: user.id,
            name: "Credential test",
            slug: `credential-${stamp}`,
          },
        });
        const owner = await tx.agent.create({
          data: {
            workspaceId: workspace.id,
            name: "Owner",
            slug: "owner",
            runtimeKind: "pi-sdk",
          },
        });
        const other = await tx.agent.create({
          data: {
            workspaceId: workspace.id,
            name: "Other",
            slug: "other",
            runtimeKind: "pi-sdk",
          },
        });
        const id = randomUUID();
        await tx.agentEnvironmentCredential.create({
          data: {
            id,
            workspaceId: workspace.id,
            agentId: owner.id,
            name: "MY_SERVICE_TOKEN",
            encryptedValue: encryptSecretText(
              JSON.stringify({
                id,
                workspaceId: workspace.id,
                agentId: owner.id,
                name: "MY_SERVICE_TOKEN",
                value: "fixture-value",
              }),
            ),
          },
        });
        const refs = [{ name: "MY_SERVICE_TOKEN", credentialId: id }];
        await expect(
          assertAgentEnvironmentCredentialReferences(
            tx,
            workspace.id,
            owner.id,
            refs,
          ),
        ).resolves.toBeUndefined();
        await expect(
          assertAgentEnvironmentCredentialReferences(
            tx,
            workspace.id,
            other.id,
            refs,
          ),
        ).rejects.toThrow("AGENT_CREDENTIAL_REVOKED");
        await expect(
          assertAgentEnvironmentCredentialReferences(
            tx,
            workspace.id,
            owner.id,
            [{ ...refs[0], name: "CHANGED_NAME" }],
          ),
        ).rejects.toThrow("AGENT_CREDENTIAL_REVOKED");
        await expect(
          assertAgentEnvironmentCredentialReferences(
            tx,
            workspace.id,
            owner.id,
            [...refs, ...refs],
          ),
        ).rejects.toThrow("AGENT_CREDENTIAL_REFERENCE_INVALID");
        await tx.agentEnvironmentCredential.update({
          where: { id },
          data: { revokedAt: new Date() },
        });
        await expect(
          assertAgentEnvironmentCredentialReferences(
            tx,
            workspace.id,
            owner.id,
            refs,
          ),
        ).rejects.toThrow("AGENT_CREDENTIAL_REVOKED");
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
});
