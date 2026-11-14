// @vitest-environment node
import { AsyncResource } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { createAgent, setAgentPiPackages } from "@/lib/agents/mutations";
import { resolvePiSessionPackages } from "@/lib/agents/pi-session-packages";
import {
  withAgentExecutionLease,
  withAgentMaintenanceLease,
} from "@/lib/agents/agent-execution-gate";
import { marketReleaseChecksum } from "@/lib/pi-packages/artifact";
import { addPlugin, updatePlugin, removePlugin } from "@/lib/plugins/installs";
import { getPlugin, listPlugins } from "@/lib/plugins/catalog";
import {
  approveAgentPluginSync,
  runPendingAgentPluginSyncs,
} from "@/lib/plugins/agent-sync";
import { publishFixtureAgentRevision } from "./agent-revision-fixture";
import type * as SandboxRuntimeModule from "@/lib/agents/sandbox-runtime";

vi.mock("@/lib/agents/sandbox-runtime", async (original) => ({
  ...(await original<typeof SandboxRuntimeModule>()),
  preflightPiSdkCapabilities: vi
    .fn()
    .mockResolvedValue({ commands: [], tools: [], skills: [], prompts: [] }),
}));

let userId: string;
let memberId: string;
let workspaceId: string;
let otherWorkspaceId: string;
let listingId: string;
let installId: string;
let agentId: string;
let draftAgentId: string;
let v1: string;
let v2: string;
let v3: string;
let oldRevisionId: string;
let oldSession: {
  workspaceId: string;
  agentId: string;
  conversationId: string;
};

function manifest(version: number, code = "export default () => {}") {
  const files = [
    { path: "package/index.mjs", content: code },
    {
      path: "package/skills/guide/SKILL.md",
      content: `---\nname: guide\ndescription: Guide\n---\nGuide ${version}`,
    },
    {
      path: "package/CHANGELOG.md",
      content: `## Unreleased\nFuture\n\n## 1.0.${version}\nFrozen notes ${version}\n\n## 0.9.0\nOlder`,
    },
  ];
  return {
    schemaVersion: 1,
    kind: "pi-package",
    listing: {
      slug: "sync-plugin",
      name: "Sync plugin",
      summary: null,
      iconUrl: null,
      author: "fixture",
      tags: [],
    },
    package: {
      source: {
        kind: "toolplane",
        requested: `toolplane:sync-plugin@1.0.${version}`,
        name: "sync-plugin",
        version: `1.0.${version}`,
      },
      name: "sync-plugin",
      version: `1.0.${version}`,
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
        skills: ["package/skills/guide"],
        prompts: [],
        themes: [],
      },
      entries: [
        ...["package", "package/skills", "package/skills/guide"].map(
          (path) => ({ type: "directory", path }),
        ),
        ...files.map(({ path, content }) => ({
          type: "file",
          path,
          contentEncoding: "base64",
          content: Buffer.from(content).toString("base64"),
          executable: false,
          sha256: createHash("sha256").update(content).digest("hex"),
        })),
      ],
    },
  };
}

async function release(version: number, codeChanged = false) {
  const artifact = manifest(
    version,
    codeChanged ? "export default () => { return 2; }" : undefined,
  );
  return db.marketRelease.create({
    data: {
      listingId,
      version,
      manifest: artifact,
      checksum: marketReleaseChecksum(artifact),
      reviewStatus: "approved",
      releaseNotes: version === 3 ? "Authored latest release notes" : null,
      releaseSummary: {
        source: {
          repository: "fixture/plugins",
          commit: String(version).repeat(40),
          path: "",
          version: `1.0.${version}`,
        },
        capabilities: {
          mcp: [],
          codeDigest: (codeChanged ? "b" : "a").repeat(64),
        },
      },
    },
  });
}

const binding = () =>
  db.agentPiPackage.findUniqueOrThrow({
    where: { agentId_marketInstallId: { agentId, marketInstallId: installId } },
  });
const agent = () => db.agent.findUniqueOrThrow({ where: { id: agentId } });

beforeAll(async () => {
  const suffix = randomUUID();
  userId = (
    await db.user.create({
      data: { email: `sync-owner-${suffix}@test.dev`, passwordHash: "fixture" },
    })
  ).id;
  memberId = (
    await db.user.create({
      data: {
        email: `sync-member-${suffix}@test.dev`,
        passwordHash: "fixture",
      },
    })
  ).id;
  workspaceId = (
    await db.workspace.create({
      data: {
        slug: `sync-${suffix}`,
        name: "Plugin sync",
        ownerId: userId,
        members: { create: { userId: memberId, role: "member" } },
      },
    })
  ).id;
  otherWorkspaceId = (
    await db.workspace.create({
      data: { slug: `other-${suffix}`, name: "Other", ownerId: userId },
    })
  ).id;
  listingId = (
    await db.marketListing.create({
      data: {
        namespace: suffix,
        slug: "sync-plugin",
        kind: "pi-package",
        publisherWorkspaceId: workspaceId,
        name: "Sync plugin",
        metadata: {},
        status: "published",
      },
    })
  ).id;
  v1 = (await release(1)).id;
  installId = (await addPlugin(workspaceId, userId, listingId)).id;
  agentId = (
    await createAgent(workspaceId, "Following plugin", {
      piPackages: [{ marketInstallId: installId }],
    })
  ).id;
  draftAgentId = (
    await createAgent(workspaceId, "Unpublished follower", {
      piPackages: [{ marketInstallId: installId }],
    })
  ).id;
  oldRevisionId = (await publishFixtureAgentRevision(workspaceId, agentId)).id;
  const conversation = await db.conversation.create({
    data: {
      agentId,
      agentRevisionId: oldRevisionId,
      legacyRevisionUnresolved: false,
    },
  });
  oldSession = { workspaceId, agentId, conversationId: conversation.id };
  expect(
    (await resolvePiSessionPackages(oldSession)).packages[0].releaseId,
  ).toBe(v1);
  v2 = (await release(2)).id;
  v3 = (await release(3, true)).id;
});

afterAll(async () => {
  // Session and revision retention is intentional; remove their owning agents first.
  if (workspaceId) await db.agent.deleteMany({ where: { workspaceId } });
  if (workspaceId)
    await db.marketInstall.deleteMany({
      where: { targetWorkspaceId: workspaceId },
    });
  if (listingId) await db.marketListing.delete({ where: { id: listingId } });
  if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } });
  if (otherWorkspaceId)
    await db.workspace.delete({ where: { id: otherWorkspaceId } });
  if (userId) await db.user.delete({ where: { id: userId } });
  if (memberId) await db.user.delete({ where: { id: memberId } });
  await db.$disconnect();
});

it("derives legacy changelogs read-only from each frozen release and keeps latest metadata consistent", async () => {
  const before = await db.marketRelease.findMany({
    where: { listingId },
    orderBy: { version: "desc" },
  });
  const plugin = await getPlugin(workspaceId, userId, listingId);
  expect(plugin.latestRelease).toEqual(plugin.releases[0]);
  expect(plugin.releases.map((item) => item.changelog)).toEqual([
    {
      text: "Authored latest release notes",
      sourceUrl: null,
      kind: "release-notes",
    },
    { text: "Frozen notes 2", sourceUrl: null, kind: "release-notes" },
    { text: "Frozen notes 1", sourceUrl: null, kind: "release-notes" },
  ]);
  expect(
    await db.marketRelease.findMany({
      where: { listingId },
      orderBy: { version: "desc" },
    }),
  ).toEqual(before);
});

it("auto-publishes unchanged capabilities during active execution while existing sessions retain their old release", async () => {
  const running = await db.workSession.create({
    data: {
      workspaceId,
      agentId,
      conversationId: (await db.conversation.create({ data: { agentId } })).id,
      runtimeKind: "pi-sdk",
      status: "running",
    },
  });
  await withAgentExecutionLease(
    { agentId, sessionId: oldSession.conversationId },
    () => updatePlugin(workspaceId, userId, installId, v2),
  );
  await db.workSession.update({
    where: { id: running.id },
    data: { status: "completed" },
  });
  expect(await binding()).toMatchObject({
    releaseId: v2,
    syncStatus: "synced",
    targetReleaseId: null,
  });
  expect((await agent()).currentRevisionVersion).toBe(2);
  expect(
    await db.agentPiPackage.findFirstOrThrow({
      where: { agentId: draftAgentId, marketInstallId: installId },
    }),
  ).toMatchObject({
    releaseId: v2,
    syncStatus: "synced",
    targetReleaseId: null,
  });
  expect(
    (await db.agent.findUniqueOrThrow({ where: { id: draftAgentId } }))
      .currentRevisionVersion,
  ).toBe(0);
  expect(
    (await resolvePiSessionPackages(oldSession)).packages[0].releaseId,
  ).toBe(v1);
  const current = await db.agentRevision.findUniqueOrThrow({
    where: { agentId_version: { agentId, version: 2 } },
  });
  const fresh = await db.conversation.create({
    data: {
      agentId,
      agentRevisionId: current.id,
      legacyRevisionUnresolved: false,
    },
  });
  expect(
    (
      await resolvePiSessionPackages({
        workspaceId,
        agentId,
        conversationId: fresh.id,
      })
    ).packages[0].releaseId,
  ).toBe(v2);
});

it("rejects a stale approval target without changing the binding or publishing a revision", async () => {
  await updatePlugin(workspaceId, userId, installId, v3);
  const before = await binding();
  const revisionVersion = (await agent()).currentRevisionVersion;
  await expect(
    approveAgentPluginSync(workspaceId, userId, agentId, installId, v2),
  ).rejects.toMatchObject({ code: "plugin_review_conflict", status: 409 });
  expect(await binding()).toEqual(before);
  expect((await agent()).currentRevisionVersion).toBe(revisionVersion);
});

it("pauses code changes without a revision, preserves review through draft edits, and applies approval", async () => {
  await updatePlugin(workspaceId, userId, installId, v3);
  expect(await binding()).toMatchObject({
    releaseId: v2,
    syncStatus: "review_required",
    targetReleaseId: v3,
  });
  expect((await agent()).currentRevisionVersion).toBe(2);
  expect(
    await db.agentPiPackage.findFirstOrThrow({
      where: { agentId: draftAgentId, marketInstallId: installId },
    }),
  ).toMatchObject({
    releaseId: v2,
    syncStatus: "review_required",
    targetReleaseId: v3,
  });
  await setAgentPiPackages(workspaceId, agentId, [
    { marketInstallId: installId },
  ]);
  expect((await binding()).syncStatus).toBe("review_required");
  await expect(
    approveAgentPluginSync(workspaceId, memberId, agentId, installId, v3),
  ).rejects.toMatchObject({ code: "not_authorized" });
  await approveAgentPluginSync(workspaceId, userId, agentId, installId, v3);
  expect(await binding()).toMatchObject({
    releaseId: v3,
    syncStatus: "synced",
    targetReleaseId: null,
  });
  expect((await agent()).currentRevisionVersion).toBe(3);
  await approveAgentPluginSync(
    workspaceId,
    userId,
    draftAgentId,
    installId,
    v3,
  );
  expect(
    await db.agentPiPackage.findFirstOrThrow({
      where: { agentId: draftAgentId, marketInstallId: installId },
    }),
  ).toMatchObject({
    releaseId: v3,
    syncStatus: "synced",
    targetReleaseId: null,
  });
  expect(
    (await db.agent.findUniqueOrThrow({ where: { id: draftAgentId } }))
      .currentRevisionVersion,
  ).toBe(0);
  expect(
    (await resolvePiSessionPackages(oldSession)).packages[0].releaseId,
  ).toBe(v1);
  await expect(
    approveAgentPluginSync(workspaceId, userId, agentId, installId, v3),
  ).rejects.toMatchObject({ code: "plugin_review_conflict", status: 409 });
});

it("queues syncs blocked by agent maintenance and retries with the updating administrator", async () => {
  const unrelated = new AsyncResource("plugin-test-unrelated");
  try {
    await withAgentMaintenanceLease(agentId, () =>
      unrelated.runInAsyncScope(() =>
        updatePlugin(workspaceId, userId, installId, v3),
      ),
    );
  } finally {
    unrelated.emitDestroy();
  }
  expect(await binding()).toMatchObject({
    syncStatus: "pending",
    syncRequestedById: userId,
    targetReleaseId: v3,
  });
  await runPendingAgentPluginSyncs();
  expect(await binding()).toMatchObject({
    releaseId: v3,
    syncStatus: "synced",
    targetReleaseId: null,
  });
});

it("fails a queued update if its requesting user loses administrator access", async () => {
  await db.membership.updateMany({
    where: { workspaceId, userId: memberId },
    data: { role: "admin" },
  });
  const version = (await agent()).currentRevisionVersion;
  const unrelated = new AsyncResource("plugin-test-demoted-admin");
  try {
    await withAgentMaintenanceLease(agentId, () =>
      unrelated.runInAsyncScope(() =>
        updatePlugin(workspaceId, memberId, installId, v3),
      ),
    );
  } finally {
    unrelated.emitDestroy();
    await db.membership.updateMany({
      where: { workspaceId, userId: memberId },
      data: { role: "member" },
    });
  }
  expect(await binding()).toMatchObject({
    syncStatus: "pending",
    syncRequestedById: memberId,
  });
  await runPendingAgentPluginSyncs();
  expect(await binding()).toMatchObject({
    syncStatus: "failed",
    syncError: "Workspace access denied.",
  });
  expect((await agent()).currentRevisionVersion).toBe(version);
});

it("isolates reads and install mutations by workspace and denies ordinary members", async () => {
  expect(
    (await listPlugins(workspaceId, memberId)).items.some(
      (item) => item.id === listingId,
    ),
  ).toBe(true);
  expect((await listPlugins(otherWorkspaceId, userId)).items).toEqual([]);
  await expect(
    getPlugin(otherWorkspaceId, userId, listingId),
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    updatePlugin(otherWorkspaceId, userId, installId, v2),
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    removePlugin(otherWorkspaceId, userId, installId),
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    approveAgentPluginSync(otherWorkspaceId, userId, agentId, installId, v3),
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    updatePlugin(workspaceId, memberId, installId, v2),
  ).rejects.toMatchObject({ code: "not_authorized" });
  expect((await binding()).releaseId).toBe(v3);
});

it("uninstalls by narrowing agent defaults without deleting session snapshots", async () => {
  const previousVersion = (await agent()).currentRevisionVersion;
  await removePlugin(workspaceId, userId, installId);
  expect(
    await db.agentPiPackage.count({
      where: { agentId, marketInstallId: installId },
    }),
  ).toBe(0);
  expect((await agent()).currentRevisionVersion).toBe(previousVersion + 1);
  const revision = await db.agentRevision.findUniqueOrThrow({
    where: { agentId_version: { agentId, version: previousVersion + 1 } },
  });
  const fresh = await db.conversation.create({
    data: {
      agentId,
      agentRevisionId: revision.id,
      legacyRevisionUnresolved: false,
    },
  });
  expect(
    (
      await resolvePiSessionPackages({
        workspaceId,
        agentId,
        conversationId: fresh.id,
      })
    ).packages,
  ).toEqual([]);
  expect(
    (await resolvePiSessionPackages(oldSession)).packages[0].releaseId,
  ).toBe(v1);
  expect(
    (await listPlugins(workspaceId, userId, { installedOnly: true })).items,
  ).toEqual([]);
});
