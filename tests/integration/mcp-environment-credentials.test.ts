// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  migrateMcpCredentials,
  parseMcpMigrationArguments,
} from "../../scripts/lib/mcp-credential-migration";
import { db } from "@/lib/db";
import {
  resolveMcpConnectionSpawnSpec,
  resolveMcpEnvironment,
  sealMcpEnvironment,
} from "@/lib/process/mcp-credentials";
import { mcpEnvironmentState } from "@/lib/workspace/mcp-environment";

const rollback = new Error("MCP credential fixture rollback");
const firstSecret = "fixture-mcp-first-secret";
const rotatedSecret = "fixture-mcp-rotated-secret";

async function withWorkspace(
  run: (tx: Prisma.TransactionClient, workspaceId: string) => Promise<void>,
) {
  await expect(
    db.$transaction(async (tx) => {
      const stamp = randomUUID();
      const user = await tx.user.create({
        data: {
          email: `mcp-credentials-${stamp}@test.invalid`,
          passwordHash: "fixture",
        },
      });
      const workspace = await tx.workspace.create({
        data: {
          ownerId: user.id,
          name: "MCP credentials",
          slug: `mcp-${stamp}`,
        },
      });
      await run(tx, workspace.id);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
}

describe("MCP encrypted environment persistence", () => {
  it("binds envelopes to workspace ownership and persists no plaintext values", async () => {
    await withWorkspace(async (tx, workspaceId) => {
      const sealed = sealMcpEnvironment(
        { env: { API_TOKEN: firstSecret, OPTIONAL: "" }, transport: "stdio" },
        workspaceId,
        { API_TOKEN: firstSecret, OPTIONAL: "" },
      );
      const deployment = await tx.deployment.create({
        data: {
          workspaceId,
          status: "stopped",
          installCfg: sealed as Prisma.InputJsonObject,
        },
      });
      const persisted = deployment.installCfg;
      expect(JSON.stringify(persisted)).not.toContain(firstSecret);
      expect(persisted).toMatchObject({ env: { API_TOKEN: "", OPTIONAL: "" } });
      expect(resolveMcpEnvironment(persisted, workspaceId)).toEqual({
        API_TOKEN: firstSecret,
        OPTIONAL: "",
      });
      expect(() =>
        resolveMcpEnvironment(persisted, `${workspaceId}-other`),
      ).toThrow("MCP_CREDENTIAL_SCOPE_INVALID");
      expect(() =>
        resolveMcpEnvironment({ env: { API_TOKEN: firstSecret } }, workspaceId),
      ).toThrow("MCP_CREDENTIAL_MIGRATION_REQUIRED");
    });
  });

  it("rejects authenticated-envelope tampering and serializes only metadata", () => {
    const sealed = sealMcpEnvironment({}, "workspace", {
      API_TOKEN: firstSecret,
      OPTIONAL: "",
    });
    const tampered = JSON.parse(JSON.stringify(sealed));
    const data = tampered.credentialEnvelope.encrypted.data as string;
    tampered.credentialEnvelope.encrypted.data = `${data[0] === "A" ? "B" : "A"}${data.slice(1)}`;
    expect(() => resolveMcpEnvironment(tampered, "workspace")).toThrow();
    const state = mcpEnvironmentState(sealed);
    expect(state).toEqual({ API_TOKEN: "configured", OPTIONAL: "" });
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain(firstSecret);
    expect(serialized).not.toContain("credentialEnvelope");
    expect(serialized).not.toContain(data);
    // Metadata must not need the decryption key or a valid authenticated payload.
    expect(mcpEnvironmentState(tampered)).toEqual(state);
    const changedMetadata = JSON.parse(JSON.stringify(sealed));
    changedMetadata.credentialEnvelope.configuredKeys = [];
    expect(() => resolveMcpEnvironment(changedMetadata, "workspace")).toThrow();
  });

  it("loads the current rotated or revoked values rather than an earlier persisted envelope", async () => {
    await withWorkspace(async (tx, workspaceId) => {
      const original = sealMcpEnvironment({}, workspaceId, {
        API_TOKEN: firstSecret,
      });
      const deployment = await tx.deployment.create({
        data: {
          workspaceId,
          status: "stopped",
          installCfg: original as Prisma.InputJsonObject,
        },
      });
      const rotated = sealMcpEnvironment(original, workspaceId, {
        API_TOKEN: rotatedSecret,
      });
      await tx.deployment.update({
        where: { id: deployment.id },
        data: { installCfg: rotated as Prisma.InputJsonObject },
      });
      const current = await tx.deployment.findUniqueOrThrow({
        where: { id: deployment.id },
      });
      expect(resolveMcpEnvironment(current.installCfg, workspaceId)).toEqual({
        API_TOKEN: rotatedSecret,
      });
      expect(JSON.stringify(current.installCfg)).not.toContain(firstSecret);
      const revoked = sealMcpEnvironment(current.installCfg, workspaceId, {
        API_TOKEN: "",
      });
      await tx.deployment.update({
        where: { id: deployment.id },
        data: { installCfg: revoked as Prisma.InputJsonObject },
      });
      const latest = await tx.deployment.findUniqueOrThrow({
        where: { id: deployment.id },
      });
      expect(resolveMcpEnvironment(latest.installCfg, workspaceId)).toEqual({
        API_TOKEN: "",
      });
      expect(mcpEnvironmentState(latest.installCfg)).toEqual({ API_TOKEN: "" });
    });
  });
  it("resolves fresh runtime headers, scopes deployment reads and fails after revocation", async () => {
    await withWorkspace(async (tx, workspaceId) => {
      const cfg = { authType: "bearer", bearerEnv: "API_TOKEN" };
      const deployment = await tx.deployment.create({
        data: {
          workspaceId,
          status: "stopped",
          source: "remote",
          sourceRef: "https://example.com/mcp",
          installCfg: sealMcpEnvironment(cfg, workspaceId, {
            API_TOKEN: firstSecret,
          }) as Prisma.InputJsonObject,
        },
      });
      // Keep real queries inside the rollback fixture; do not mock credential data.
      const query = vi
        .spyOn(db.deployment, "findFirst")
        .mockImplementation(tx.deployment.findFirst.bind(tx.deployment));
      try {
        const input = { workspaceId, deploymentId: deployment.id };
        const initial = await resolveMcpConnectionSpawnSpec(input);
        expect(initial.spec).toMatchObject({
          kind: "remote",
          headers: { authorization: `Bearer ${firstSecret}` },
        });
        expect(initial.redactionValues).toContain(firstSecret);
        await expect(
          resolveMcpConnectionSpawnSpec({
            ...input,
            workspaceId: `${workspaceId}-other`,
          }),
        ).rejects.toThrow("MCP_CONNECTION_UNAVAILABLE");
        await tx.deployment.update({
          where: { id: deployment.id },
          data: {
            installCfg: sealMcpEnvironment(cfg, workspaceId, {
              API_TOKEN: rotatedSecret,
            }) as Prisma.InputJsonObject,
          },
        });
        const rotated = await resolveMcpConnectionSpawnSpec(input);
        expect(rotated.spec).toMatchObject({
          headers: { authorization: `Bearer ${rotatedSecret}` },
        });
        expect(rotated.redactionValues).not.toContain(firstSecret);
        await tx.deployment.update({
          where: { id: deployment.id },
          data: {
            installCfg: sealMcpEnvironment(cfg, workspaceId, {
              API_TOKEN: "",
            }) as Prisma.InputJsonObject,
          },
        });
        await expect(resolveMcpConnectionSpawnSpec(input)).rejects.toThrow();
      } finally {
        query.mockRestore();
      }
    });
  });
});

describe("controlled MCP credential migration", () => {
  it("requires explicit workspace scope and defaults to dry-run", () => {
    expect(parseMcpMigrationArguments(["--workspace", "owned"])).toEqual({
      workspaceId: "owned",
      apply: false,
    });
    expect(
      parseMcpMigrationArguments(["--apply", "--workspace", "owned"]),
    ).toEqual({ workspaceId: "owned", apply: true });
    for (const args of [
      [],
      ["--apply"],
      ["--workspace", "--apply"],
      ["--workspace", "owned", "--force"],
    ]) {
      expect(() => parseMcpMigrationArguments(args)).toThrow(
        "MCP_MIGRATION_ARGUMENTS_INVALID",
      );
    }
  });

  it("dry-runs without writes, applies explicit legacy values and is idempotent", async () => {
    await withWorkspace(async (tx, workspaceId) => {
      const legacy = {
        env: { API_TOKEN: firstSecret, OPTIONAL: "" },
        transport: "stdio",
      };
      const deployment = await tx.deployment.create({
        data: { workspaceId, status: "stopped", installCfg: legacy },
      });
      const dry = await migrateMcpCredentials(tx, { workspaceId });
      expect(dry).toEqual({
        mode: "dry-run",
        scanned: 1,
        candidates: 1,
        migrated: 0,
      });
      expect(
        (
          await tx.deployment.findUniqueOrThrow({
            where: { id: deployment.id },
          })
        ).installCfg,
      ).toEqual(legacy);
      const applied = await migrateMcpCredentials(tx, {
        workspaceId,
        apply: true,
      });
      expect(applied).toEqual({
        mode: "apply",
        scanned: 1,
        candidates: 1,
        migrated: 1,
      });
      expect(JSON.stringify(applied)).not.toContain(firstSecret);
      const persisted = (
        await tx.deployment.findUniqueOrThrow({ where: { id: deployment.id } })
      ).installCfg;
      expect(JSON.stringify(persisted)).not.toContain(firstSecret);
      expect(resolveMcpEnvironment(persisted, workspaceId)).toEqual(legacy.env);
      expect(
        await migrateMcpCredentials(tx, { workspaceId, apply: true }),
      ).toEqual({ mode: "apply", scanned: 1, candidates: 0, migrated: 0 });
      expect(
        (
          await tx.deployment.findUniqueOrThrow({
            where: { id: deployment.id },
          })
        ).installCfg,
      ).toEqual(persisted);
    });
  });

  it("refuses running/provisioning deployments before any writes, including dry-run", async () => {
    await withWorkspace(async (tx, workspaceId) => {
      const legacy = { env: { API_TOKEN: firstSecret } };
      const idle = await tx.deployment.create({
        data: { workspaceId, status: "stopped", installCfg: legacy },
      });
      const active = await tx.deployment.create({
        data: { workspaceId, status: "running" },
      });
      for (const status of ["running", "provisioning"]) {
        await tx.deployment.update({
          where: { id: active.id },
          data: { status },
        });
        for (const apply of [false, true]) {
          await expect(
            migrateMcpCredentials(tx, { workspaceId, apply }),
          ).rejects.toThrow("MCP_MIGRATION_DEPLOYMENTS_NOT_STOPPED");
        }
      }
      expect(
        (await tx.deployment.findUniqueOrThrow({ where: { id: idle.id } }))
          .installCfg,
      ).toEqual(legacy);
    });
  });

  it("CAS refuses concurrent configuration changes without overwriting them", async () => {
    await withWorkspace(async (tx, workspaceId) => {
      const deployment = await tx.deployment.create({
        data: {
          workspaceId,
          status: "stopped",
          installCfg: { env: { API_TOKEN: firstSecret } },
        },
      });
      // Interpose a real database mutation between the helper's read and CAS.
      const concurrent = { env: { API_TOKEN: rotatedSecret } };
      const racingTx = {
        deployment: {
          findMany: async (args: Prisma.DeploymentFindManyArgs) => {
            const rows = await tx.deployment.findMany(args);
            await tx.deployment.update({
              where: { id: deployment.id },
              data: { installCfg: concurrent },
            });
            return rows;
          },
          updateMany: tx.deployment.updateMany.bind(tx.deployment),
        },
      } as unknown as Prisma.TransactionClient;
      await expect(
        migrateMcpCredentials(racingTx, { workspaceId, apply: true }),
      ).rejects.toThrow("MCP_MIGRATION_CONCURRENT_CHANGE");
      expect(
        (
          await tx.deployment.findUniqueOrThrow({
            where: { id: deployment.id },
          })
        ).installCfg,
      ).toEqual(concurrent);
    });
  });

  it("rolls back the full batch if a later configuration is invalid", async () => {
    const stamp = randomUUID();
    let deploymentId = "";
    await expect(
      db.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            email: `mcp-rollback-${stamp}@test.invalid`,
            passwordHash: "fixture",
          },
        });
        const workspace = await tx.workspace.create({
          data: {
            ownerId: user.id,
            name: "Rollback",
            slug: `rollback-${stamp}`,
          },
        });
        const valid = await tx.deployment.create({
          data: {
            id: `a-${stamp}`,
            workspaceId: workspace.id,
            status: "stopped",
            installCfg: { env: { API_TOKEN: firstSecret } },
          },
        });
        deploymentId = valid.id;
        await tx.deployment.create({
          data: {
            id: `z-${stamp}`,
            workspaceId: workspace.id,
            status: "stopped",
            installCfg: { env: { INVALID: 42 } },
          },
        });
        await migrateMcpCredentials(tx, {
          workspaceId: workspace.id,
          apply: true,
        });
      }),
    ).rejects.toThrow("MCP_MIGRATION_CONFIG_INVALID");
    expect(
      await db.deployment.findUnique({ where: { id: deploymentId } }),
    ).toBeNull();
  });
});
