// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterAll, beforeAll, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createApiToken, revokeApiToken } from "@/lib/auth/tokens";
import { marketReleaseChecksum } from "@/lib/market/artifact";
import { getMarketInstallReleaseDiff } from "@/lib/market/install-release-diff";
import type { PiPackageManifestV1 } from "@/lib/market/pi-package-manifest";
import type { SkillReleaseManifestV1 } from "@/lib/market/skill-manifest";
import {
  parseMcpMarketManifest,
  type McpMarketManifestV1,
} from "@/lib/market/resources";
import { GET } from "@/app/api/v1/workspaces/[slug]/market/installs/[installId]/diff/route";

const stamp = randomUUID();
const listingIds: string[] = [];
let userId: string;
let workspaceId: string;
let foreignUserId: string;
let foreignWorkspaceId: string;
let sequence = 0;
const listing = {
  slug: "diff-fixture",
  name: "Diff fixture",
  summary: null,
  iconUrl: null,
  tags: [],
  author: "Fixture",
};
const privateBytes = "NEVER_RETURN_PRIVATE_ARTIFACT_BYTES";
function file(path: string, content: string, executable = false) {
  return {
    type: "file" as const,
    path,
    contentEncoding: "base64" as const,
    content: Buffer.from(content).toString("base64"),
    executable,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}
function pi(version = "1.0.0"): PiPackageManifestV1 {
  return {
    schemaVersion: 1,
    kind: "pi-package",
    listing,
    package: {
      source: {
        kind: "toolplane",
        requested: `toolplane:diff-fixture@${version}`,
        name: "diff-fixture",
        version,
      },
      name: "diff-fixture",
      version,
      root: "package",
      runtime: {
        kind: "pi-sdk",
        piVersion: "0.87.1",
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
        file(
          "package/index.mjs",
          `export default () => {}; // ${privateBytes}`,
        ),
      ],
      toolplane: {
        schemaVersion: 1,
        mcp: [{ key: "search", name: "Search", tools: ["lookup"] }],
      },
    },
  };
}
function skill(): SkillReleaseManifestV1 {
  return {
    schemaVersion: 1,
    kind: "skill",
    listing,
    skill: {
      name: "Diff Skill",
      slug: "diff-skill",
      description: null,
      content: `Old Skill ${privateBytes}`,
      files: [
        { path: "same.txt", content: "same bytes" },
        { path: "change.bin", content: "AQI=", encoding: "base64" },
        { path: "remove.txt", content: "remove" },
      ],
      userInvocable: true,
      agentInvocable: true,
      effort: "default",
      source: { type: "upload" },
    },
  };
}
function mcp(): McpMarketManifestV1 {
  return {
    schemaVersion: 1,
    kind: "mcp",
    listing,
    mcp: {
      name: "Diff MCP",
      slug: "diff-mcp",
      description: null,
      author: null,
      iconUrl: null,
      readme: null,
      recipe: {
        source: "npm",
        ref: "@fixture/mcp",
        command: "npx",
        args: ["@fixture/mcp", "--private-config", privateBytes],
        env: ["API_KEY"],
      },
      toolExposure: "all",
      allowedTools: [],
      toolCatalog: [
        { name: "lookup", inputSchema: { type: "object", properties: {} } },
      ],
    },
  };
}
async function pair(kind: string, before: unknown, after: unknown) {
  const record = await db.marketListing.create({
    data: {
      namespace: stamp,
      slug: `pair-${++sequence}`,
      kind,
      name: "Release diff",
      metadata: {},
      status: "published",
      visibility: "public",
      publisherWorkspaceId: workspaceId,
    },
  });
  listingIds.push(record.id);
  const releases = [];
  for (const [index, value] of [before, after].entries()) {
    const manifest: Prisma.InputJsonValue = JSON.parse(
      JSON.stringify(kind === "mcp" ? parseMcpMarketManifest(value) : value),
    );
    releases.push(
      await db.marketRelease.create({
        data: {
          listingId: record.id,
          version: index + 1,
          manifest,
          checksum: marketReleaseChecksum(manifest),
          releaseSummary: {},
          reviewStatus: "approved",
        },
      }),
    );
  }
  const install = await db.marketInstall.create({
    data: {
      targetWorkspaceId: workspaceId,
      listingId: record.id,
      currentReleaseId: releases[0].id,
      requestedReleaseId: releases[0].id,
      status: "ready",
      idempotencyKey: randomUUID(),
      resourceMap: {},
    },
  });
  return {
    installId: install.id,
    targetReleaseId: releases[1].id,
    currentReleaseId: releases[0].id,
    listingId: record.id,
  };
}
function input(record: { installId: string; targetReleaseId: string }) {
  return {
    workspaceId,
    userId,
    installId: record.installId,
    targetReleaseId: record.targetReleaseId,
  };
}
beforeAll(async () => {
  const user = await db.user.create({
    data: { email: `diff-${stamp}@test.dev`, passwordHash: "fixture" },
  });
  userId = user.id;
  const foreign = await db.user.create({
    data: { email: `diff-foreign-${stamp}@test.dev`, passwordHash: "fixture" },
  });
  foreignUserId = foreign.id;
  workspaceId = (
    await db.workspace.create({
      data: { slug: `diff-${stamp}`, name: "Diff fixture", ownerId: userId },
    })
  ).id;
  foreignWorkspaceId = (
    await db.workspace.create({
      data: {
        slug: `diff-foreign-${stamp}`,
        name: "Foreign",
        ownerId: foreignUserId,
      },
    })
  ).id;
});
afterAll(async () => {
  await db.marketInstall.deleteMany({
    where: {
      targetWorkspaceId: {
        in: [workspaceId, foreignWorkspaceId].filter(Boolean),
      },
    },
  });
  await db.marketListing.deleteMany({ where: { id: { in: listingIds } } });
  await db.workspace.deleteMany({
    where: { id: { in: [workspaceId, foreignWorkspaceId].filter(Boolean) } },
  });
  await db.user.deleteMany({
    where: { id: { in: [userId, foreignUserId].filter(Boolean) } },
  });
});

it("compares Pi hashes, executable modes, link targets and types with bounded stable pagination", async () => {
  const before = pi();
  before.package.entries.push(
    file("package/a.txt", "before"),
    file("package/remove.txt", "remove"),
    file("package/mode.sh", "same", false),
    { type: "symlink", path: "package/link", target: "a.txt" },
    { type: "directory", path: "package/type" },
  );
  const after = pi("2.0.0");
  after.package.entries.push(
    file("package/a.txt", "after"),
    file("package/z-add.txt", "add"),
    file("package/mode.sh", "same", true),
    { type: "symlink", path: "package/link", target: "index.mjs" },
    file("package/type", "changed type"),
  );
  after.package.toolplane = {
    schemaVersion: 1,
    mcp: [{ key: "search", name: "Search", tools: ["lookup", "write"] }],
  };
  after.package.runtime = {
    kind: "pi-sdk",
    piVersion: "0.87.1",
    nodeMajor: 26,
    platform: "linux",
    arch: "x64",
  };
  const record = await pair("pi-package", before, after);
  const result = await getMarketInstallReleaseDiff({
    ...input(record),
    pageSize: 2,
    page: 2,
  });
  expect(result.files).toEqual({
    items: [
      { path: "package/mode.sh", status: "changed" },
      { path: "package/remove.txt", status: "removed" },
    ],
    page: 2,
    pageSize: 2,
    total: 6,
    counts: { added: 1, removed: 1, changed: 4 },
  });
  expect(result.from).toEqual({
    releaseId: record.currentReleaseId,
    version: 1,
  });
  expect(result.to).toEqual({ releaseId: record.targetReleaseId, version: 2 });
  expect(result.permissions.before.requirements[0].tools).toEqual(["lookup"]);
  expect(result.permissions.after.requirements[0].tools).toEqual([
    "lookup",
    "write",
  ]);
  expect(result.compatibility.after).toMatchObject({
    runtime: "pi-sdk",
    platform: "linux",
    arch: "x64",
  });
  expect(result.configurationChanged).toBe(true);
  expect(
    (await getMarketInstallReleaseDiff({ ...input(record), pageSize: 1_000 }))
      .files.pageSize,
  ).toBe(100);
  expect(JSON.stringify(result)).not.toContain(privateBytes);
  expect(JSON.stringify(result)).not.toContain(
    Buffer.from(privateBytes).toString("base64"),
  );
});
it("compares Skill content and relative-file bytes, not text versus base64 representation", async () => {
  const before = skill();
  const after = skill();
  after.skill.content = "New Skill content";
  after.skill.files = [
    {
      path: "same.txt",
      content: Buffer.from("same bytes").toString("base64"),
      encoding: "base64",
    },
    { path: "change.bin", content: "AQM=", encoding: "base64" },
    { path: "add.txt", content: "add" },
  ];
  const record = await pair("skill", before, after);
  const result = await getMarketInstallReleaseDiff(input(record));
  expect(result.files.items).toEqual([
    { path: "SKILL.md", status: "changed" },
    { path: "add.txt", status: "added" },
    { path: "change.bin", status: "changed" },
    { path: "remove.txt", status: "removed" },
  ]);
  expect(result.files.counts).toEqual({ added: 1, removed: 1, changed: 2 });
  expect(result.compatibility).toEqual({ before: null, after: null });
  expect(result.configurationChanged).toBe(false);
  expect(JSON.stringify(result)).not.toContain(privateBytes);
});
it("projects only MCP permission/environment names, transport and a configuration-change flag", async () => {
  const before = mcp();
  const after = mcp();
  after.mcp.recipe = {
    source: "remote",
    ref: "https://private-endpoint.example.test/rpc",
    env: ["API_KEY"],
    transport: "sse",
    authType: "headers",
    headerEnv: { "x-api-key": "API_KEY", "x-tenant": "TENANT" },
  };
  after.mcp.toolCatalog?.push({
    name: "write",
    inputSchema: { type: "object", properties: {} },
  });
  const result = await getMarketInstallReleaseDiff(
    input(await pair("mcp", before, after)),
  );
  expect(result.files.total).toBe(0);
  expect(result.permissions.before).toEqual({
    requirements: [{ key: "mcp", name: "Diff MCP", tools: ["lookup"] }],
    requiredEnvironment: ["API_KEY"],
    transport: "stdio",
  });
  expect(result.permissions.after.requiredEnvironment).toEqual([
    "API_KEY",
    "TENANT",
  ]);
  expect(result.permissions.after.requirements[0].tools).toEqual([
    "lookup",
    "write",
  ]);
  expect(result.compatibility.after).toEqual({
    runtime: "mcp",
    transport: "sse",
  });
  expect(result.configurationChanged).toBe(true);
  const json = JSON.stringify(result);
  for (const forbidden of [
    privateBytes,
    "private-endpoint.example.test",
    "args",
    "recipe",
    "content",
    "inputSchema",
  ])
    expect(json).not.toContain(forbidden);
});
it("uses each approved release discovery snapshot rather than the current catalog or publication tools", async () => {
  const record = await pair("mcp", mcp(), mcp());
  await db.marketRelease.update({
    where: { id: record.currentReleaseId },
    data: {
      releaseSummary: {
        toolCatalog: [
          {
            name: "reviewed-before",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    },
  });
  await db.marketRelease.update({
    where: { id: record.targetReleaseId },
    data: { releaseSummary: { toolCatalog: [] } },
  });
  const result = await getMarketInstallReleaseDiff(input(record));
  expect(result.permissions.before.requirements[0].tools).toEqual([
    "reviewed-before",
  ]);
  expect(result.permissions.after.requirements[0].tools).toEqual([]);
});
it("rejects foreign install/workspace access and foreign private target releases", async () => {
  const own = await pair("skill", skill(), skill());
  const foreign = await pair("skill", skill(), skill());
  await db.marketListing.update({
    where: { id: foreign.listingId },
    data: { visibility: "private", publisherWorkspaceId: foreignWorkspaceId },
  });
  await expect(
    getMarketInstallReleaseDiff({ ...input(own), userId: foreignUserId }),
  ).rejects.toMatchObject({ code: "not_authorized" });
  await expect(
    getMarketInstallReleaseDiff({
      ...input(own),
      workspaceId: foreignWorkspaceId,
      userId: foreignUserId,
    }),
  ).rejects.toMatchObject({ code: "install_not_found" });
  await expect(
    getMarketInstallReleaseDiff({
      ...input(own),
      targetReleaseId: foreign.targetReleaseId,
    }),
  ).rejects.toMatchObject({ code: "release_not_found" });
  await expect(
    getMarketInstallReleaseDiff(input(foreign)),
  ).rejects.toMatchObject({ code: "listing_unavailable" });
});
it("revalidates target/current approvals, checksums and active workspace on every request", async () => {
  const record = await pair("skill", skill(), skill());
  await db.marketRelease.update({
    where: { id: record.targetReleaseId },
    data: { reviewStatus: "rejected" },
  });
  await expect(
    getMarketInstallReleaseDiff(input(record)),
  ).rejects.toMatchObject({ code: "release_not_found" });
  await db.marketRelease.update({
    where: { id: record.targetReleaseId },
    data: { reviewStatus: "approved", checksum: "tampered" },
  });
  await expect(
    getMarketInstallReleaseDiff(input(record)),
  ).rejects.toMatchObject({ code: "invalid_manifest" });
  await db.marketRelease.update({
    where: { id: record.targetReleaseId },
    data: { checksum: marketReleaseChecksum(skill()) },
  });
  await db.marketRelease.update({
    where: { id: record.currentReleaseId },
    data: { reviewStatus: "rejected" },
  });
  await expect(
    getMarketInstallReleaseDiff(input(record)),
  ).rejects.toMatchObject({ code: "release_not_found" });
  await db.marketRelease.update({
    where: { id: record.currentReleaseId },
    data: { reviewStatus: "approved", checksum: "tampered" },
  });
  await expect(
    getMarketInstallReleaseDiff(input(record)),
  ).rejects.toMatchObject({ code: "invalid_manifest" });
  await db.workspace.update({
    where: { id: workspaceId },
    data: { status: "suspended" },
  });
  try {
    await expect(
      getMarketInstallReleaseDiff(input(record)),
    ).rejects.toMatchObject({ code: "not_authorized" });
  } finally {
    await db.workspace.update({
      where: { id: workspaceId },
      data: { status: "active" },
    });
  }
});
it("serves the scoped diff through account-token GET with no-store headers and rejects invalid pagination", async () => {
  const record = await pair("skill", skill(), skill());
  const credential = await createApiToken(userId, "Release diff fixture");
  const workspace = await db.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
  });
  const params = {
    params: Promise.resolve({
      slug: workspace.slug,
      installId: record.installId,
    }),
  };
  const url = `http://localhost/api/v1/workspaces/${workspace.slug}/market/installs/${record.installId}/diff?targetReleaseId=${record.targetReleaseId}`;
  const headers = { authorization: `Bearer ${credential.token}` };
  try {
    const response = await GET(new Request(url, { headers }), params);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      from: { releaseId: record.currentReleaseId },
      to: { releaseId: record.targetReleaseId },
      files: { total: 0 },
    });
    expect(
      (await GET(new Request(`${url}&page=-1`, { headers }), params)).status,
    ).toBe(400);
    expect(
      (
        await GET(
          new Request(url, {
            headers: { authorization: "Bearer invalid-diff-fixture" },
          }),
          params,
        )
      ).status,
    ).toBe(401);
  } finally {
    await revokeApiToken(userId, credential.record.id);
  }
});

it("rejects noncanonical Skill paths and unsupported resource kinds without projecting artifacts", async () => {
  const unsafe = skill();
  unsafe.skill.files = [{ path: "../escape.txt", content: privateBytes }];
  const record = await pair("skill", skill(), unsafe);
  await expect(
    getMarketInstallReleaseDiff(input(record)),
  ).rejects.toMatchObject({ code: "invalid_manifest" });
  const unsupported = await pair("toolkit", {}, {});
  await expect(
    getMarketInstallReleaseDiff(input(unsupported)),
  ).rejects.toMatchObject({ code: "unsupported_resource_kind" });
});
