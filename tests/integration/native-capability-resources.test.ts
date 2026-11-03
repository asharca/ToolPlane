// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { createApiToken } from "@/lib/auth/tokens";
import { PUT as saveInstructionsApi } from "@/app/api/v1/agents/[agentId]/instructions/route";
import { resolveCapabilitySubagents } from "@/lib/agents/subagents";
import {
  readOmpInstructions,
  saveOmpInstructionsDraft,
} from "@/lib/agents/omp-config-server";
import { publishFixtureAgentRevision } from "./agent-revision-fixture";
import { emptyOmpConfig } from "@/lib/agents/omp-config";
import { marketReleaseChecksum } from "@/lib/pi-packages/artifact";
import { SubagentDefinitionSchema } from "@/lib/agents/capability-contracts";
import { AgentRevisionConfigSchema } from "@/lib/agents/revision-types";
import {
  createPrivatePlugin,
  appendPrivatePluginVersion,
  pluginInstallConfig,
} from "@/lib/plugins/local";
import { parsePiPackageReleaseManifest } from "@/lib/pi-packages/manifest";
import { getPlugin } from "@/lib/plugins/catalog";

const stamp = randomUUID();
const users: string[] = [],
  workspaces: string[] = [];
let userId = "",
  workspaceId = "",
  agentId = "",
  ownerToken = "",
  foreignToken = "",
  slug = "";
const definition = SubagentDefinitionSchema.parse({
  schemaVersion: 1,
  runtimeKind: "omp",
  systemPrompt: "Review the supplied text.",
  model: null,
  permissions: { builtinTools: ["read", "bash"], mcpTools: [], skillIds: [] },
  maxSteps: 10,
});
beforeAll(async () => {
  for (const name of ["owner", "foreign"]) {
    const user = await db.user.create({
      data: {
        email: `native-capability-${stamp}-${name}@example.invalid`,
        passwordHash: "fixture",
      },
    });
    users.push(user.id);
    const workspace = await db.workspace.create({
      data: {
        slug: `native-capability-${stamp}-${name}`,
        name,
        ownerId: user.id,
      },
    });
    workspaces.push(workspace.id);
    const token = await createApiToken(user.id, "capability integration");
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        name,
        slug: name,
        runtimeKind: "omp",
        ompConfig: emptyOmpConfig(),
      },
    });
    if (name === "owner") {
      userId = user.id;
      workspaceId = workspace.id;
      agentId = agent.id;
      ownerToken = token.token;
      slug = workspace.slug;
    } else {
      foreignToken = token.token;
    }
  }
});
afterAll(async () => {
  await db.agent.deleteMany({ where: { workspaceId: { in: workspaces } } });
  await db.workspaceSubagent.deleteMany({
    where: { workspaceId: { in: workspaces } },
  });
  await db.marketInstall.deleteMany({
    where: { targetWorkspaceId: { in: workspaces } },
  });
  await db.marketListing.deleteMany({
    where: { publisherWorkspaceId: { in: workspaces } },
  });
  await db.workspace.deleteMany({ where: { id: { in: workspaces } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
});

it("retains immutable native child history but never captures it into a new revision", async () => {
  const baseline = await publishFixtureAgentRevision(workspaceId, agentId);
  const { child, version } = await db.$transaction(async (tx) => {
    const child = await tx.workspaceSubagent.create({
      data: { workspaceId, name: "Historical child" },
    });
    const version = await tx.workspaceSubagentVersion.create({
      data: {
        subagentId: child.id,
        version: 1,
        definition,
        checksum: marketReleaseChecksum(definition),
      },
    });
    await tx.agentSubagentBinding.create({
      data: {
        agentId,
        subagentId: child.id,
        versionId: version.id,
        enabled: true,
      },
    });
    return { child, version };
  });
  const config = AgentRevisionConfigSchema.parse(baseline.config);
  delete config.subagentMode;
  delete config.nativeSubagentPolicy;
  config.subagents = [
    { subagentId: child.id, versionId: version.id, checksum: version.checksum },
  ];
  const historical = await db.agentRevision.create({
    data: {
      agentId,
      version: baseline.version + 1,
      config: config as Prisma.InputJsonValue,
    },
  });
  await db.agent.update({
    where: { id: agentId },
    data: { currentRevisionVersion: historical.version },
  });
  const resolved = await db.$transaction((tx) =>
    resolveCapabilitySubagents(tx, workspaceId, agentId, config),
  );
  expect(resolved[0].versionId).toBe(version.id);
  expect(resolved[0].definition.systemPrompt).toBe(definition.systemPrompt);
  const next = await publishFixtureAgentRevision(workspaceId, agentId);
  expect(AgentRevisionConfigSchema.parse(next.config).subagents).toEqual([]);
  expect(
    (await db.agentRevision.findUniqueOrThrow({ where: { id: historical.id } }))
      .config,
  ).toEqual(historical.config);
  await db.workspaceSubagent.update({
    where: { id: child.id },
    data: { revokedAt: new Date() },
  });
  expect(
    await db.$transaction((tx) =>
      resolveCapabilitySubagents(tx, workspaceId, agentId, config),
    ),
  ).toEqual([]);
});

it("preserves historical resource snapshots while editing only appended instructions", async () => {
  const legacy = {
    ...emptyOmpConfig(),
    files: [
      { path: "AGENTS.md", content: "Follow workspace instructions." },
      {
        path: "agents/reviewer.md",
        content:
          "---\nname: Imported reviewer\ntools: read\n---\nReview changes carefully.",
      },
      {
        path: "skills/check/SKILL.md",
        content:
          "---\nname: check\ndescription: Check a patch\n---\nCheck the patch.",
      },
      { path: "skills/check/guide.md", content: "Reference guide" },
      {
        path: "hooks/post/audit.ts",
        content:
          "export default function (pi) { pi.on('session_start', async () => {}); }",
      },
    ],
  };
  await db.agent.update({
    where: { id: agentId },
    data: { ompConfig: legacy },
  });
  const old = await db.$transaction(async (tx) => {
    const baseline = await tx.agentRevision.findFirstOrThrow({
      where: { agentId },
      orderBy: { version: "desc" },
    });
    const config = AgentRevisionConfigSchema.parse(baseline.config);
    if (config.runtimeKind !== "omp") throw new Error("Expected OMP fixture");
    delete config.subagents;
    const revision = await tx.agentRevision.create({
      data: {
        agentId,
        version: baseline.version + 1,
        config: {
          ...config,
          ompConfig: legacy,
          ompConfigChecksum: marketReleaseChecksum(legacy),
        } as Prisma.InputJsonValue,
      },
    });
    await tx.agent.update({
      where: { id: agentId },
      data: { currentRevisionVersion: revision.version },
    });
    return revision;
  });
  const before = await db.workspaceSubagent.count({ where: { workspaceId } });
  const files = [
    { path: "AGENTS.md", content: "Updated workspace instructions." },
  ];
  await saveOmpInstructionsDraft({ workspaceId, userId, agentId, files });
  expect(
    (await readOmpInstructions(workspaceId, userId, agentId)).files,
  ).toEqual(files.map((file) => ({ ...file, mode: "append" })));
  const draft = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
  expect(draft.ompConfig).toEqual({
    ...legacy,
    files: [
      ...legacy.files.filter((file) => file.path !== "AGENTS.md"),
      ...files,
    ],
  });
  expect(await db.workspaceSubagent.count({ where: { workspaceId } })).toBe(
    before,
  );
  const published = await publishFixtureAgentRevision(workspaceId, agentId);
  const next = AgentRevisionConfigSchema.parse(published.config);
  if (next.runtimeKind !== "omp") throw new Error("Expected OMP fixture");
  expect(next.ompConfig.files).toEqual(files);
  expect(next.ompConfig.plugins).toBeUndefined();
  expect(next.skills).toEqual([]);
  expect(next.packages).toEqual([]);
  expect(await db.workspaceSubagent.count({ where: { workspaceId } })).toBe(
    before,
  );
  expect(
    (await db.agentRevision.findUniqueOrThrow({ where: { id: old.id } }))
      .config,
  ).toEqual(old.config);
  await db.agent.update({
    where: { id: agentId },
    data: { ompConfig: emptyOmpConfig() },
  });
});

it("retains private executable versions and requires review when hook/config authority changes", async () => {
  const bundle = {
    name: "@fixture/private-hook",
    version: "1.0.0",
    runtimeKind: "omp",
    files: [
      {
        path: "index.ts",
        content:
          "export default function(api) { api.on('agent_end', async () => {}); }",
        mode: 493,
      },
    ],
    hooks: ["index.ts"],
    config: { enabled: true },
  };
  const first = await createPrivatePlugin(workspaceId, userId, bundle);
  await db.agentPiPackage.create({
    data: {
      agentId,
      marketInstallId: first.installId,
      releaseId: first.releaseId,
    },
  });
  const updated = await appendPrivatePluginVersion(
    workspaceId,
    userId,
    first.installId,
    { ...bundle, version: "1.0.1", config: { enabled: false } },
  );
  expect(updated.installId).toBe(first.installId);
  expect(updated.releaseId).not.toBe(first.releaseId);
  const pending = await db.agentPiPackage.findUniqueOrThrow({
    where: {
      agentId_marketInstallId: { agentId, marketInstallId: first.installId },
    },
  });
  expect(pending.releaseId).toBe(first.releaseId);
  expect(pending.syncStatus).toBe("review_required");
  const original = await db.marketRelease.findUniqueOrThrow({
    where: { id: first.releaseId },
  });
  const file = parsePiPackageReleaseManifest(
    original.manifest,
    original.checksum,
  ).package.entries[0];
  expect(file.type === "file" && file.executable).toBe(true);
  await expect(
    pluginInstallConfig(workspaceId, users[1], first.installId),
  ).rejects.toMatchObject({ code: "not_authorized" });
  await expect(
    createPrivatePlugin(workspaceId, userId, {
      ...bundle,
      files: [
        {
          path: "index.ts",
          content: Buffer.from(`api_key = "sk-${"x".repeat(40)}"`).toString(
            "base64",
          ),
          encoding: "base64",
        },
      ],
    }),
  ).rejects.toMatchObject({ code: "PLUGIN_CONTAINS_SECRET" });
});

it("persists only version-specific local notes and serves unmatched files as immutable full changelogs", async () => {
  const input = (version: string, text: string) => ({
    name: "@fixture/changelog",
    version,
    runtimeKind: "omp",
    hooks: ["index.ts"],
    files: [
      { path: "index.ts", content: "export default function () {}" },
      { path: "CHANGELOG.md", content: text },
    ],
  });
  const first = await createPrivatePlugin(
    workspaceId,
    userId,
    input("1.0.0", "## 1.0.0\nFirst notes"),
  );
  const original = await db.marketRelease.findUniqueOrThrow({
    where: { id: first.releaseId },
  });
  expect(original.releaseNotes).toBe("First notes");
  const unmatchedText = "## Unreleased\nFuture plans\n\n## 1.0.0\nFirst notes";
  const unmatched = await appendPrivatePluginVersion(
    workspaceId,
    userId,
    first.installId,
    input("1.0.1", unmatchedText),
  );
  expect(
    (
      await db.marketRelease.findUniqueOrThrow({
        where: { id: unmatched.releaseId },
      })
    ).releaseNotes,
  ).toBeNull();
  const latest = await appendPrivatePluginVersion(
    workspaceId,
    userId,
    first.installId,
    input("1.0.2", "## 1.0.2\nLatest notes\n\n## 1.0.0\nRewritten history"),
  );
  expect(
    (
      await db.marketRelease.findUniqueOrThrow({
        where: { id: latest.releaseId },
      })
    ).releaseNotes,
  ).toBe("Latest notes");
  const plugin = await getPlugin(workspaceId, userId, original.listingId);
  expect(plugin.latestRelease?.changelog).toEqual({
    text: "Latest notes",
    sourceUrl: null,
    kind: "release-notes",
  });
  expect(
    plugin.releases.find((item) => item.id === unmatched.releaseId)?.changelog,
  ).toEqual({ text: unmatchedText, sourceUrl: null, kind: "changelog" });
  expect(
    plugin.releases.find((item) => item.id === first.releaseId)?.changelog
      ?.text,
  ).toBe("First notes");
  expect(
    await db.marketRelease.findUniqueOrThrow({
      where: { id: first.releaseId },
    }),
  ).toEqual(original);
  await expect(
    createPrivatePlugin(
      workspaceId,
      userId,
      input("2.0.0", `## Unreleased\nsk-${"x".repeat(40)}`),
    ),
  ).rejects.toMatchObject({ code: "PLUGIN_CONTAINS_SECRET" });
});

it("edits imported append instructions without replacing primary instructions or capability bindings", async () => {
  await db.agent.update({
    where: { id: agentId },
    data: {
      systemPrompt: "Primary instructions remain independently editable.",
    },
  });
  const before = await db.agent.findUniqueOrThrow({
    where: { id: agentId },
    include: { capabilitySubagents: true, skills: true, piPackages: true },
  });
  const files = [
    {
      path: "SYSTEM.md",
      content: "Imported main source is additional context.",
    },
    { path: "APPEND_SYSTEM.md", content: "Updated append instructions." },
    { path: "rules/review.md", content: "Apply the review rules." },
  ];
  const request = (token: string, value = files) =>
    new Request(`http://localhost/api/v1/agents/${agentId}/instructions`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ workspace: slug, files: value }),
    });
  const denied = await saveInstructionsApi(request(foreignToken), {
    params: Promise.resolve({ agentId }),
  });
  expect(denied.status).toBe(404);
  const saved = await saveInstructionsApi(request(ownerToken), {
    params: Promise.resolve({ agentId }),
  });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ saved: true });
  const after = await db.agent.findUniqueOrThrow({
    where: { id: agentId },
    include: { capabilitySubagents: true, skills: true, piPackages: true },
  });
  expect(after.systemPrompt).toBe(before.systemPrompt);
  expect(after.capabilityImport).toEqual(before.capabilityImport);
  expect(after.currentRevisionVersion).toBe(before.currentRevisionVersion);
  expect(after.capabilitySubagents).toEqual(before.capabilitySubagents);
  expect(after.skills).toEqual(before.skills);
  expect(after.piPackages).toEqual(before.piPackages);
  const view = await readOmpInstructions(workspaceId, userId, agentId);
  expect(view.files).toEqual(
    files.map((file) => ({ ...file, mode: "append" })),
  );
  const invalid = await saveInstructionsApi(
    request(ownerToken, [
      {
        path: "agents/not-instructions.md",
        content: "Must not alter child resources.",
      },
    ]),
    { params: Promise.resolve({ agentId }) },
  );
  expect(invalid.status).toBe(400);
});

it("derives private native entrypoints from the frozen manifest and rejects unknown features before publication", async () => {
  const bundle = {
    name: "@fixture/native-features",
    version: "1.0.0",
    runtimeKind: "omp",
    enabledFeatures: ["review"],
    hooks: ["misreported.ts"],
    files: [
      {
        path: "package.json",
        content: JSON.stringify({
          name: "@fixture/native-features",
          version: "1.0.0",
          omp: {
            hooks: ["main.ts"],
            features: { review: { hooks: ["review.ts"] } },
          },
        }),
      },
      { path: "main.ts", content: "export default function(api) {}" },
      { path: "review.ts", content: "export default function(api) {}" },
      { path: "misreported.ts", content: "export default function(api) {}" },
    ],
  };
  const count = await db.marketListing.count({
    where: { publisherWorkspaceId: workspaceId },
  });
  await expect(
    createPrivatePlugin(workspaceId, userId, {
      ...bundle,
      enabledFeatures: ["unknown"],
    }),
  ).rejects.toMatchObject({ code: "PLUGIN_FEATURES_UNAVAILABLE" });
  expect(
    await db.marketListing.count({
      where: { publisherWorkspaceId: workspaceId },
    }),
  ).toBe(count);
  const installed = await createPrivatePlugin(workspaceId, userId, bundle);
  const release = await db.marketRelease.findUniqueOrThrow({
    where: { id: installed.releaseId },
  });
  expect(
    parsePiPackageReleaseManifest(release.manifest, release.checksum).package
      .resources.hooks,
  ).toEqual(["package/main.ts", "package/review.ts"]);
  await expect(
    createPrivatePlugin(workspaceId, userId, {
      ...bundle,
      files: bundle.files.filter((file) => file.path !== "review.ts"),
    }),
  ).rejects.toMatchObject({ code: "PLUGIN_FEATURES_UNAVAILABLE" });
});
