// @vitest-environment node
import { randomUUID, createHash } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  createAgent,
  updateAgent,
  setAgentPiPackages,
} from "@/lib/agents/mutations";
import { withSandboxExecutionLease } from "@/lib/agents/sandbox-execution-gate";

import { resolvePiSessionPackages } from "@/lib/agents/pi-session-packages";
import { marketReleaseChecksum } from "@/lib/pi-packages/artifact";
import { removePlugin } from "@/lib/plugins/installs";
import { revokeDangerousMarketRelease } from "@/lib/pi-packages/revocation";
import { publishFixtureAgentRevision } from "./agent-revision-fixture";
import type * as SandboxRuntimeModule from "@/lib/agents/sandbox-runtime";
vi.mock("@/lib/agents/sandbox-runtime", async (original) => ({
  ...(await original<typeof SandboxRuntimeModule>()),
  preflightPiSdkCapabilities: vi
    .fn()
    .mockResolvedValue({ commands: [], tools: [], skills: [], prompts: [] }),
}));
let workspaceId: string;
let userId: string;
let installId: string;
let v1: string;
let v2: string;
let foreignRelease: string;
const listingIds: string[] = [];
const cfg = {
  name: "SDK",
  systemPrompt: "",
  providerId: null,
  model: null,
  maxSteps: 10,
};
const manifest = {
  schemaVersion: 1,
  kind: "pi-package",
  listing: {
    slug: "session-fixture",
    name: "Session fixture",
    summary: null,
    iconUrl: null,
    author: "fixture",
    tags: [],
  },
  package: {
    source: {
      kind: "toolplane",
      requested: "toolplane:session-fixture@1.0.0",
      name: "session-fixture",
      version: "1.0.0",
    },
    name: "session-fixture",
    version: "1.0.0",
    root: "package",
    runtime: {
      kind: "pi-sdk",
      piVersion: "1.5.2",
      nodeMajor: 26,
      platform: "any",
      arch: "any",
    },
    resources: {
      extensions: ["package/index.mjs"],
      skills: [],
      prompts: [],
      themes: [],
    },
    entries: [
      { type: "directory", path: "package" },
      {
        type: "file",
        path: "package/index.mjs",
        contentEncoding: "base64",
        content: Buffer.from("export default () => {}").toString("base64"),
        executable: false,
        sha256: createHash("sha256")
          .update("export default () => {}")
          .digest("hex"),
      },
    ],
  },
};
beforeAll(async () => {
  const suffix = randomUUID();
  const user = await db.user.create({
    data: { email: `${suffix}@test.dev`, passwordHash: "x", role: "admin" },
  });
  userId = user.id;
  const ws = await db.workspace.create({
    data: { slug: suffix, name: "Packages", ownerId: userId },
  });
  workspaceId = ws.id;
  for (const slug of ["package", "foreign"]) {
    const listing = await db.marketListing.create({
      data: {
        namespace: suffix,
        slug,
        kind: "pi-package",
        publisherWorkspaceId: workspaceId,
        name: slug,
        metadata: {},
        status: "published",
      },
    });
    listingIds.push(listing.id);
  }
  const releases = await Promise.all(
    [1, 2].map((version) =>
      db.marketRelease.create({
        data: {
          listingId: listingIds[0],
          version,
          manifest,
          releaseSummary: {},
          checksum: marketReleaseChecksum(manifest),
          reviewStatus: "approved",
        },
      }),
    ),
  );
  [v1, v2] = releases.map((release) => release.id);
  foreignRelease = (
    await db.marketRelease.create({
      data: {
        listingId: listingIds[1],
        version: 1,
        manifest,
        releaseSummary: {},
        checksum: marketReleaseChecksum(manifest),
        reviewStatus: "approved",
      },
    })
  ).id;
  installId = (
    await db.marketInstall.create({
      data: {
        listingId: listingIds[0],
        currentReleaseId: v1,
        targetWorkspaceId: workspaceId,
        idempotencyKey: suffix,
        status: "ready",
        resourceMap: { kind: "pi-package" },
      },
    })
  ).id;
});
afterAll(async () => {
  if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } });
  if (listingIds.length)
    await db.marketListing.deleteMany({ where: { id: { in: listingIds } } });
  if (userId) await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});
it("pins creation, preserves old approved bindings, rejects foreign releases and edits drafts during sandbox execution", async () => {
  const agent = await createAgent(workspaceId, "SDK", {
    piPackages: [{ marketInstallId: installId, releaseId: v1 }],
  });
  const binding = () =>
    db.agentPiPackage.findUniqueOrThrow({
      where: {
        agentId_marketInstallId: {
          agentId: agent.id,
          marketInstallId: installId,
        },
      },
    });
  expect((await binding()).releaseId).toBe(v1);
  await expect(
    updateAgent(workspaceId, agent.id, {
      ...cfg,
      piPackages: [{ marketInstallId: installId, releaseId: foreignRelease }],
    }),
  ).rejects.toThrow("Release not approved");
  await db.marketInstall.update({
    where: { id: installId },
    data: { currentReleaseId: v2 },
  });
  await updateAgent(workspaceId, agent.id, {
    ...cfg,
    piPackages: [{ marketInstallId: installId, releaseId: v1 }],
  });
  expect((await binding()).releaseId).toBe(v1);
  const sandbox = await db.agentSandbox.findFirstOrThrow({
    where: { agentId: agent.id },
  });
  await withSandboxExecutionLease(sandbox.sandboxId, async () => {
    await updateAgent(workspaceId, agent.id, {
      ...cfg,
      piPackages: [{ marketInstallId: installId, releaseId: v2 }],
    });
    expect((await binding()).releaseId).toBe(v2);
  });
  await updateAgent(workspaceId, agent.id, { ...cfg, piPackages: [] });
  expect(await db.agentPiPackage.count({ where: { agentId: agent.id } })).toBe(
    0,
  );
});
it("creates fresh native drafts without applying grants and keeps historical runtimes read-only", async () => {
  const prior = await createAgent(workspaceId, "Prior", {
    piPackages: [{ marketInstallId: installId }],
  });
  expect(prior.runtimeKind).toBe("pi-sdk");
  expect(
    await db.agentPiPackage.findUniqueOrThrow({
      where: {
        agentId_marketInstallId: {
          agentId: prior.id,
          marketInstallId: installId,
        },
      },
    }),
  ).toMatchObject({ releaseId: v2 });
  expect(prior.currentRevisionVersion).toBe(0);
  const historical = await db.agent.create({
    data: {
      workspaceId,
      name: "Historical",
      slug: randomUUID(),
      runtimeKind: "claude-code",
    },
  });
  await expect(
    updateAgent(workspaceId, historical.id, { ...cfg, piPackages: [] }),
  ).rejects.toThrow("Historical Agents are read-only");
  expect(
    await db.agent.findUnique({ where: { id: historical.id } }),
  ).not.toBeNull();
});
it("rejects foreign workspace installs, duplicates and arbitrary fields, and edits drafts while Work runs", async () => {
  await db.marketInstall.update({
    where: { id: installId },
    data: { currentReleaseId: v2 },
  });
  const packages = [{ marketInstallId: installId, releaseId: v2 }];
  const agent = await createAgent(workspaceId, "Bound SDK", {
    piPackages: packages,
  });
  await expect(
    updateAgent(workspaceId, agent.id, {
      ...cfg,
      piPackages: [...packages, ...packages],
    }),
  ).rejects.toThrow("Duplicate marketInstallId");
  await expect(
    updateAgent(workspaceId, agent.id, {
      ...cfg,
      piPackages: [
        { ...packages[0], path: "/tmp/code" } as (typeof packages)[number],
      ],
    }),
  ).rejects.toThrow("pi_packages_invalid");
  const foreignWorkspace = await db.workspace.create({
    data: { slug: randomUUID(), name: "Foreign", ownerId: userId },
  });
  try {
    await expect(
      createAgent(foreignWorkspace.id, "Foreign SDK", {
        piPackages: packages,
      }),
    ).rejects.toThrow("Unknown or inaccessible market install");
  } finally {
    await db.workspace.delete({ where: { id: foreignWorkspace.id } });
  }
  const conversation = await db.conversation.create({
    data: { agentId: agent.id },
  });
  await db.workSession.create({
    data: {
      workspaceId,
      agentId: agent.id,
      conversationId: conversation.id,
      runtimeKind: "pi-sdk",
      status: "running",
    },
  });
  await updateAgent(workspaceId, agent.id, { ...cfg, piPackages: [] });
  expect(await db.agentPiPackage.count({ where: { agentId: agent.id } })).toBe(
    0,
  );
});

it("restores original session code after default changes/uninstall and rejects revoked releases", async () => {
  await db.marketInstall.update({
    where: { id: installId },
    data: { currentReleaseId: v1 },
  });
  const agent = await createAgent(workspaceId, "Session SDK", {
    piPackages: [{ marketInstallId: installId, releaseId: v1 }],
  });
  const makeSession = async () => {
    const deployment = await db.deployment.create({ data: { workspaceId } });
    const sandbox = await db.sandbox.create({
      data: {
        workspaceId,
        name: "Session",
        slug: randomUUID(),
        deploymentId: deployment.id,
      },
    });
    const revision = await publishFixtureAgentRevision(workspaceId, agent.id);
    const conversation = await db.conversation.create({
      data: {
        agentId: agent.id,
        sandboxId: sandbox.id,
        agentRevisionId: revision.id,
        legacyRevisionUnresolved: false,
      },
    });
    return {
      workspaceId,
      agentId: agent.id,
      sandboxId: sandbox.id,
      conversationId: conversation.id,
      runtimeSessionId: conversation.id,
    };
  };
  const old = await makeSession();
  expect((await resolvePiSessionPackages(old)).packages[0].releaseId).toBe(v1);
  await db.marketInstall.update({
    where: { id: installId },
    data: { currentReleaseId: v2 },
  });
  await setAgentPiPackages(workspaceId, agent.id, [
    { marketInstallId: installId, releaseId: v2 },
  ]);
  expect((await resolvePiSessionPackages(old)).packages[0].releaseId).toBe(v1);
  const fresh = await makeSession();
  expect((await resolvePiSessionPackages(fresh)).packages[0].releaseId).toBe(
    v2,
  );
  await expect(
    resolvePiSessionPackages({ ...old, conversationId: fresh.conversationId }),
  ).rejects.toThrow("PI_PACKAGE_UNAVAILABLE");
  await expect(
    resolvePiSessionPackages({
      ...old,
      runtimeSessionId: fresh.conversationId,
    }),
  ).rejects.toThrow("PI_PACKAGE_UNAVAILABLE");
  const otherAgent = await createAgent(workspaceId, "Other session owner");
  const otherConversation = await db.conversation.create({
    data: { agentId: otherAgent.id },
  });
  await expect(
    resolvePiSessionPackages({ ...old, conversationId: otherConversation.id }),
  ).rejects.toThrow("PI_PACKAGE_UNAVAILABLE");
  expect(
    (
      await db.piSessionPackageSet.findUniqueOrThrow({
        where: { conversationId: old.conversationId },
      })
    ).conversationId,
  ).toBe(old.conversationId);
  // Two independently pinned sessions may occupy the same Agent sandbox.
  await db.$transaction(async (tx) => {
    await tx.conversation.update({
      where: { id: fresh.conversationId },
      data: { sandboxId: old.sandboxId },
    });
    await tx.piSessionPackageSet.update({
      where: { conversationId: fresh.conversationId },
      data: { sandboxId: old.sandboxId },
    });
  });
  fresh.sandboxId = old.sandboxId;
  expect((await resolvePiSessionPackages(fresh)).packages[0].releaseId).toBe(
    v2,
  );
  expect((await resolvePiSessionPackages(old)).packages[0].releaseId).toBe(v1);
  const shared = await db.deployment.create({
    data: { workspaceId, name: "Shared MCP" },
  });
  await db.marketInstall.update({
    where: { id: installId },
    data: {
      resourceMap: {
        kind: "pi-package",
        mcpBindings: { shared: { deploymentId: shared.id, tools: ["lookup"] } },
      },
    },
  });
  await expect(
    db.marketRelease.delete({ where: { id: v1 } }),
  ).rejects.toThrow();
  await removePlugin(workspaceId, userId, installId);
  expect(
    await db.deployment.findUnique({ where: { id: shared.id } }),
  ).not.toBeNull();
  expect((await resolvePiSessionPackages(old)).packages[0].releaseId).toBe(v1);
  expect(
    (await resolvePiSessionPackages(await makeSession())).packages,
  ).toEqual([]);
  await db.workspace.update({
    where: { id: workspaceId },
    data: { status: "suspended" },
  });
  await expect(resolvePiSessionPackages(old)).rejects.toThrow(
    "AGENT_EXECUTION_RETIRED",
  );
  await db.workspace.update({
    where: { id: workspaceId },
    data: { status: "active" },
  });
  await revokeDangerousMarketRelease({
    workspaceId,
    userId,
    releaseId: v1,
    reason: "Dangerous fixture code",
  });
  await expect(resolvePiSessionPackages(old)).rejects.toMatchObject({
    code: "listing_unavailable",
  });
  await expect(
    resolvePiSessionPackages({
      ...old,
      runtimeSessionId: fresh.conversationId,
    }),
  ).rejects.toThrow("PI_PACKAGE_UNAVAILABLE");
  await db.agent.update({
    where: { id: agent.id },
    data: { retiredAt: new Date() },
  });
  await expect(resolvePiSessionPackages(old)).rejects.toThrow(
    "AGENT_EXECUTION_RETIRED",
  );
  await db.agent.update({
    where: { id: agent.id },
    data: { retiredAt: null, runtimeKind: "claude-code" },
  });
  await expect(resolvePiSessionPackages(old)).rejects.toThrow(
    "AGENT_EXECUTION_RETIRED",
  );
  await db.agent.update({
    where: { id: agent.id },
    data: { runtimeKind: "pi-sdk" },
  });
  expect(
    await db.piSessionPackageSet.findUniqueOrThrow({
      where: { conversationId: old.conversationId },
      include: { packages: true },
    }),
  ).toMatchObject({
    conversationId: old.conversationId,
    packages: [{ releaseId: v1 }],
  });
});
