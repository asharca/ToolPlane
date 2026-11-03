// @vitest-environment node
import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { db } from "@/lib/db";
import { previewOmpImport, commitOmpImport } from "@/lib/agents/omp-import";
import type { OmpImportRequest } from "@/lib/agents/omp-import-contract";
import { PrivatePluginInputSchema } from "@/lib/agents/capability-contracts";
import * as runtime from "@/lib/agents/sandbox-runtime";
import * as sandboxes from "@/lib/sandboxes/runtime";
import * as native from "@/lib/agents/omp-preflight";
import * as principal from "@/lib/auth/current-user";
import * as tokens from "@/lib/auth/tokens";
import { POST as previewRoute } from "@/app/api/v1/workspaces/[slug]/agents/import/preview/route";
import { createAgent, createConversation } from "@/lib/agents/mutations";
import { publishFixtureAgentRevision } from "./agent-revision-fixture";
import { resolveMcpEnvironment } from "@/lib/process/mcp-credentials";
import {
  createPrivatePlugin,
  appendPrivatePluginVersion,
} from "@/lib/plugins/local";
import { approveAgentPluginSync } from "@/lib/plugins/agent-sync";
import { resolveNativeRoleModels } from "@/lib/agents/native-role-models";
import { AgentRevisionConfigSchema } from "@/lib/agents/revision-types";
import type * as SupervisorModule from "@/lib/process/supervisor";
import type * as ConfigVolumeModule from "@/lib/process/deployment-config-volume";
import type * as McpClientModule from "@/lib/process/mcp-client";

// These database integration cases mock external Docker/network boundaries only.
// Parent acceptance separately executes actual imported skills/MCP/extensions.
const external = vi.hoisted(() => ({
  tools: [{ name: "arithmetic", inputSchema: { type: "object" } }],
  starts: vi.fn(),
  stops: vi.fn(),
}));
vi.mock("@/lib/process/supervisor", async (original) => ({
  ...(await original<typeof SupervisorModule>()),
  startProcess: external.starts,
  stopProcess: external.stops,
}));
vi.mock("@/lib/process/deployment-runtime-container", () => ({
  removeDeploymentContainer: vi.fn(),
}));
vi.mock("@/lib/process/deployment-config-volume", async (original) => ({
  ...(await original<typeof ConfigVolumeModule>()),
  removeDeploymentConfigVolume: vi.fn(),
}));
vi.mock("@/lib/process/mcp-client", async (original) => ({
  ...(await original<typeof McpClientModule>()),
  listMcpTools: vi.fn(async () => external.tools),
}));
let userId = "",
  workspaceId = "",
  slug = "",
  providerId = "";
const scope = () => ({ userId, workspaceId, slug });
function request(): OmpImportRequest {
  return {
    runtimeKind: "pi-sdk",
    excludedIds: [],
    inspectMcp: false,
    providerId,
    model: "fixture",
    bundle: {
      schemaVersion: 1,
      kind: "omp-import",
      ompVersion: "18.14.0",
      name: "Imported",
      settings: {},
      instructions: [
        { path: "SYSTEM.md", content: "Imported additional guidance." },
      ],
      skills: [
        {
          id: "skill:guide",
          name: "guide",
          content:
            "---\nname: guide\ndescription: Fixture guide\n---\nRead data.json.",
          files: [{ path: "data.json", content: '{"value":42}' }],
        },
      ],
      plugins: [],
      mcpServers: [],
      issues: [],
    },
  };
}
function roleRequest(): OmpImportRequest {
  const input = request();
  input.runtimeKind = "omp";
  input.bundle.modelRoles = {
    backend: "source/backend:auto",
    frontend: "source/frontend:high",
  };
  input.bundle.plugins = [
    {
      id: "plugin:roles",
      plugin: PrivatePluginInputSchema.parse({
        name: `role-fixture-${randomUUID()}`,
        runtimeKind: "omp",
        subagents: ["backend.md", "frontend.md"],
        files: [
          {
            path: "backend.md",
            content:
              '---\nname: backend\nmodel: "@backend"\ntools: ["read"]\n---\nImplement APIs.',
          },
          {
            path: "frontend.md",
            content:
              '---\nname: frontend\nmodel: "@frontend"\ntools: ["read"]\n---\nImplement interfaces.',
          },
        ],
      }),
    },
  ];
  return input;
}
async function commit(input: OmpImportRequest) {
  const preview = await previewOmpImport(scope(), input);
  return commitOmpImport(scope(), {
    ...input,
    confirmed: true,
    previewChecksum: preview.checksum,
  });
}
function remote(input: OmpImportRequest) {
  input.inspectMcp = true;
  input.bundle.mcpServers = [
    {
      id: "mcp:fixture",
      name: "fixture",
      config: {
        type: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: `Bearer \${TOKEN}` },
      },
      requiredSecrets: ["TOKEN"],
    },
  ];
  input.mcpSecrets = { "mcp:fixture": { TOKEN: "private-test-credential" } };
  return input;
}
beforeAll(async () => {
  process.env.AUTH_SECRET ??= "omp-import-integration-signing-secret";
  const user = await db.user.create({
    data: {
      email: `omp-import-${randomUUID()}@test.dev`,
      passwordHash: "x",
      status: "active",
    },
  });
  userId = user.id;
  slug = `omp-import-${randomUUID()}`;
  const workspace = await db.workspace.create({
    data: {
      slug,
      name: "Import fixture",
      ownerId: userId,
      members: { create: { userId, role: "owner" } },
    },
  });
  workspaceId = workspace.id;
  const provider = await db.modelProvider.create({
    data: {
      workspaceId,
      name: "Fixture",
      format: "openai",
      baseUrl: "https://example.com/v1",
      apiKey: "fixture",
      models: ["fixture"],
    },
  });
  providerId = provider.id;
});
afterEach(() => {
  vi.restoreAllMocks();
  external.starts.mockClear();
  external.stops.mockClear();
  external.tools = [{ name: "arithmetic", inputSchema: { type: "object" } }];
});
afterAll(async () => {
  const listings = await db.marketListing.findMany({
    where: { publisherWorkspaceId: workspaceId },
    select: { id: true },
  });
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.marketRelease.deleteMany({
    where: { listingId: { in: listings.map((listing) => listing.id) } },
  });
  await db.marketListing.deleteMany({
    where: { id: { in: listings.map((listing) => listing.id) } },
  });
  await db.user.delete({ where: { id: userId } });
});
function publicationBoundaries() {
  vi.spyOn(sandboxes, "resolveDockerImageDigest").mockResolvedValue(
    `fixture@sha256:${"a".repeat(64)}`,
  );
  vi.spyOn(runtime, "preflightPiSdkCapabilities").mockResolvedValue({
    commands: [],
    tools: [],
    skills: [],
    prompts: [],
  });
  vi.spyOn(native, "preflightOmpCapabilities").mockResolvedValue(undefined);
}
describe("optional OMP import", () => {
  it("does not fall back to session auth after an invalid explicit token", async () => {
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
    vi.spyOn(principal, "getCurrentUser").mockResolvedValue(user);
    vi.spyOn(tokens, "verifyApiTokenContext").mockResolvedValue(null);
    const response = await previewRoute(
      new Request(
        `http://localhost/api/v1/workspaces/${slug}/agents/import/preview`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer invalid",
            "content-type": "application/json",
          },
          body: JSON.stringify(request()),
        },
      ),
      { params: Promise.resolve({ slug }) },
    );
    expect(response.status).toBe(401);
  });
  it("requires explicit inspection permission before running or connecting MCP", async () => {
    const input = remote(request());
    input.inspectMcp = false;
    const preview = await previewOmpImport(scope(), input);
    expect(preview.canImport).toBe(false);
    expect(
      preview.resources.find((resource) => resource.kind === "mcp")?.messages,
    ).toContain("OMP_IMPORT_MCP_INSPECTION_APPROVAL_REQUIRED");
    expect(external.starts).not.toHaveBeenCalled();
  });
  it("blocks local executable paths and plaintext launch/header secrets without echoing them", async () => {
    const input = remote(request());
    input.bundle.mcpServers[0].config = {
      command: "/usr/bin/node",
      args: ["server.js"],
    };
    const local = await previewOmpImport(scope(), input);
    expect(local.canImport).toBe(false);
    expect(
      local.resources.find((resource) => resource.kind === "mcp")?.messages,
    ).toContain("OMP_IMPORT_MCP_PATH_MAPPING_REQUIRED");
    input.bundle.mcpServers[0].config = {
      command: "npx",
      args: ["fixture@1.0.0", "--token=do-not-echo"],
    };
    const secret = await previewOmpImport(scope(), input);
    expect(secret.canImport).toBe(false);
    expect(JSON.stringify(secret)).not.toContain("do-not-echo");
    expect(external.starts).not.toHaveBeenCalled();
  });
  it("requires confirmation separately from a valid static preview", async () => {
    const input = request();
    const preview = await previewOmpImport(scope(), input);
    await expect(
      commitOmpImport(scope(), { ...input, previewChecksum: preview.checksum }),
    ).rejects.toMatchObject({ code: "OMP_IMPORT_CONFIRMATION_REQUIRED" });
  });
  it("rejects changed selection bytes and cross-workspace preview reuse", async () => {
    const input = request();
    const preview = await previewOmpImport(scope(), input);
    await expect(
      commitOmpImport(scope(), {
        ...input,
        name: "Changed",
        confirmed: true,
        previewChecksum: preview.checksum,
      }),
    ).rejects.toMatchObject({ code: "OMP_IMPORT_PREVIEW_CHANGED" });
    await expect(
      commitOmpImport(
        { ...scope(), workspaceId: "foreign" },
        { ...input, confirmed: true, previewChecksum: preview.checksum },
      ),
    ).rejects.toMatchObject({ code: "OMP_IMPORT_PREVIEW_CHANGED" });
  });
  it("revalidates revoked workspace authorization", async () => {
    const input = request();
    const preview = await previewOmpImport(scope(), input);
    await db.user.update({
      where: { id: userId },
      data: { status: "suspended" },
    });
    try {
      await expect(
        commitOmpImport(scope(), {
          ...input,
          confirmed: true,
          previewChecksum: preview.checksum,
        }),
      ).rejects.toMatchObject({ code: "not_authorized" });
    } finally {
      await db.user.update({
        where: { id: userId },
        data: { status: "active" },
      });
    }
  });
  it("exposes missing source resources and requires explicit exclusion", async () => {
    const input = request();
    input.bundle.issues.push({
      id: "role-model",
      path: "agents/reviewer.md",
      code: "ROLE_MODEL_UNRESOLVED",
      message: "Role model cannot be mapped.",
      severity: "blocked",
      resourceId: "plugin:missing-role",
    });
    const blocked = await previewOmpImport(scope(), input);
    expect(blocked.canImport).toBe(false);
    expect(
      blocked.resources.find(
        (resource) => resource.id === "plugin:missing-role",
      ),
    ).toMatchObject({
      kind: "plugin",
      status: "blocked",
      name: "agents/reviewer.md",
    });
    input.excludedIds = ["plugin:missing-role"];
    const excluded = await previewOmpImport(scope(), input);
    expect(excluded.canImport).toBe(true);
    expect(
      excluded.resources.find(
        (resource) => resource.id === "plugin:missing-role",
      )?.status,
    ).toBe("excluded");
  });
  it("requires reviewed per-role models and rejects foreign or unavailable catalog selections", async () => {
    const input = roleRequest();
    const unreviewed = await previewOmpImport(scope(), input);
    expect(unreviewed.canImport).toBe(false);
    expect(unreviewed.nativeRoles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "backend", modelHint: "@backend" }),
        expect.objectContaining({ name: "frontend", modelHint: "@frontend" }),
      ]),
    );
    input.bundle.plugins[0].plugin.nativeRoleModels = {
      "backend.md": { providerId, model: "fixture" },
      "frontend.md": { providerId, model: "fixture" },
    };
    expect((await previewOmpImport(scope(), input)).canImport).toBe(false);
    const foreign = await db.workspace.create({
      data: {
        slug: `foreign-role-${randomUUID()}`,
        name: "Foreign",
        ownerId: userId,
      },
    });
    try {
      const provider = await db.modelProvider.create({
        data: {
          workspaceId: foreign.id,
          name: "Foreign",
          format: "openai",
          baseUrl: "https://example.com/v1",
          apiKey: "fixture",
          models: ["fixture"],
        },
      });
      input.roleModels = {
        "plugin:roles": {
          "backend.md": { providerId: provider.id, model: "fixture" },
          "frontend.md": { providerId, model: "fixture" },
        },
      };
      expect((await previewOmpImport(scope(), input)).canImport).toBe(false);
      input.roleModels["plugin:roles"]["backend.md"] = {
        providerId,
        model: "not-in-catalog",
      };
      expect((await previewOmpImport(scope(), input)).canImport).toBe(false);
      input.roleModels["plugin:roles"]["backend.md"] = {
        providerId,
        model: "fixture",
      };
      const reviewed = await previewOmpImport(scope(), input);
      expect(reviewed.canImport).toBe(true);
      input.roleModels["plugin:roles"]["backend.md"] = {
        providerId,
        model: "not-reviewed",
      };
      await expect(
        commitOmpImport(scope(), {
          ...input,
          confirmed: true,
          previewChecksum: reviewed.checksum,
        }),
      ).rejects.toMatchObject({ code: "OMP_IMPORT_PREVIEW_CHANGED" });
    } finally {
      await db.workspace.delete({ where: { id: foreign.id } });
    }
  });
  it("pins independent role model grants, requires update review and never advances an existing conversation implicitly", async () => {
    publicationBoundaries();
    const input = roleRequest();
    const provider = await db.modelProvider.create({
      data: {
        workspaceId,
        name: `Role models ${randomUUID()}`,
        format: "openai",
        baseUrl: "https://example.com/v1",
        apiKey: "fixture",
        models: ["backend", "frontend", "next-backend"],
      },
    });
    input.roleModels = {
      "plugin:roles": {
        "backend.md": { providerId: provider.id, model: "backend" },
        "frontend.md": { providerId: provider.id, model: "frontend" },
      },
    };
    const imported = await commit(input);
    const first = await db.agentRevision.findFirstOrThrow({
      where: { agentId: imported.agentId },
      orderBy: { version: "desc" },
    });
    const config = AgentRevisionConfigSchema.parse(first.config);
    expect(config.model).toBe("fixture");
    expect(
      config.nativeRoleModels?.map((role) => [
        role.name,
        role.providerId,
        role.model,
      ]),
    ).toEqual([
      ["backend", provider.id, "backend"],
      ["frontend", provider.id, "frontend"],
    ]);
    const conversation = await createConversation(
      workspaceId,
      imported.agentId,
    );
    if (!conversation) throw new Error("Fixture conversation unavailable");
    const resolve = () =>
      db.$transaction((tx) =>
        resolveNativeRoleModels(tx, workspaceId, imported.agentId, config),
      );
    expect((await resolve()).map((role) => role.model)).toEqual([
      "backend",
      "frontend",
    ]);
    const binding = await db.agentPiPackage.findFirstOrThrow({
      where: { agentId: imported.agentId },
    });
    const updated = await appendPrivatePluginVersion(
      workspaceId,
      userId,
      binding.marketInstallId,
      {
        ...input.bundle.plugins[0].plugin,
        nativeRoleModels: {
          ...input.roleModels["plugin:roles"],
          "backend.md": { providerId: provider.id, model: "next-backend" },
        },
      },
    );
    const pending = await db.agentPiPackage.findUniqueOrThrow({
      where: {
        agentId_marketInstallId: {
          agentId: imported.agentId,
          marketInstallId: binding.marketInstallId,
        },
      },
    });
    expect(pending.syncStatus).toBe("review_required");
    expect((await resolve()).map((role) => role.model)).toEqual([
      "backend",
      "frontend",
    ]);
    const applied = await approveAgentPluginSync(
      workspaceId,
      userId,
      imported.agentId,
      binding.marketInstallId,
      updated.releaseId,
    );
    expect(applied.syncStatus).toBe("synced");
    const latest = await db.agentRevision.findFirstOrThrow({
      where: { agentId: imported.agentId },
      orderBy: { version: "desc" },
    });
    expect(
      AgentRevisionConfigSchema.parse(latest.config).nativeRoleModels?.map(
        (role) => role.model,
      ),
    ).toEqual(
      ["backend", "frontend"].map((model) =>
        model === "backend" ? "next-backend" : model,
      ),
    );
    expect(
      (
        await db.conversation.findUniqueOrThrow({
          where: { id: conversation.id },
        })
      ).agentRevisionId,
    ).toBe(first.id);
    expect(
      (await db.agentRevision.findUniqueOrThrow({ where: { id: first.id } }))
        .config,
    ).toEqual(first.config);
    // The new live role mapping revokes the old pair, but cannot add its replacement to the old pin.
    expect((await resolve()).map((role) => role.model)).toEqual(["frontend"]);
    await db.modelProvider.update({
      where: { id: provider.id },
      data: { models: ["backend", "next-backend"] },
    });
    await expect(resolve()).rejects.toMatchObject({
      code: "modelOverrideUnavailable",
    });
  });
  it("blocks unsupported Pi settings/plugins and imports explicitly excluded common resources", async () => {
    publicationBoundaries();
    const input = request();
    input.bundle.settings = { "compaction.enabled": false };
    input.bundle.plugins = [
      {
        id: "plugin:omp-only",
        plugin: PrivatePluginInputSchema.parse({
          name: "omp-only",
          runtimeKind: "omp",
          hooks: ["hook.mjs"],
          files: [
            { path: "hook.mjs", content: "export default function() {}" },
          ],
        }),
      },
    ];
    const blocked = await previewOmpImport(scope(), input);
    expect(blocked.canImport).toBe(false);
    input.excludedIds = ["settings", "plugin:omp-only"];
    const result = await commit(input);
    const agent = await db.agent.findUniqueOrThrow({
      where: { id: result.agentId },
      include: { skills: { include: { installedSkill: true } } },
    });
    expect(agent.runtimeKind).toBe("pi-sdk");
    expect(agent.currentRevisionVersion).toBe(1);
    expect(agent.skills[0]?.installedSkill.files).toEqual([
      { path: "data.json", content: '{"value":42}' },
    ]);
    expect(agent.systemPrompt).toContain("Imported additional guidance");
  });
  it("migrates an explicit Pi-declared extension through the standard immutable package pipeline", async () => {
    publicationBoundaries();
    const input = request();
    input.bundle.plugins = [
      {
        id: "plugin:compatible",
        plugin: PrivatePluginInputSchema.parse({
          name: "compatible",
          runtimeKind: "omp",
          extensions: ["extension.mjs"],
          files: [
            {
              path: "package.json",
              content: JSON.stringify({
                name: "compatible",
                version: "1.0.0",
                pi: { extensions: ["extension.mjs"] },
                omp: { extensions: ["extension.mjs"] },
              }),
            },
            {
              path: "extension.mjs",
              content:
                "export default function(pi) { pi.registerCommand('fixture', {description:'Fixture',handler:async()=>{}}) }",
            },
          ],
        }),
      },
    ];
    const result = await commit(input);
    const binding = await db.agentPiPackage.findFirstOrThrow({
      where: { agentId: result.agentId },
      include: { release: true },
    });
    expect(binding.release.manifest).toMatchObject({
      package: {
        runtime: { kind: "pi-sdk" },
        resources: { extensions: ["package/extension.mjs"] },
      },
    });
    expect(runtime.preflightPiSdkCapabilities).toHaveBeenCalled();
  });
  it("keeps credentials out of preview/revisions and encrypted in the MCP resource", async () => {
    publicationBoundaries();
    const input = remote(request());
    const preview = await previewOmpImport(scope(), input);
    expect(preview.canImport).toBe(true);
    expect(JSON.stringify(preview)).not.toContain("private-test-credential");
    expect(
      await db.deployment.count({ where: { workspaceId, source: "remote" } }),
    ).toBe(0);
    const result = await commitOmpImport(scope(), {
      ...input,
      confirmed: true,
      previewChecksum: preview.checksum,
    });
    const grant = await db.agentServer.findFirstOrThrow({
      where: { agentId: result.agentId },
      include: { deployment: true },
    });
    expect(grant.allowedToolNames).toEqual(["arithmetic"]);
    expect(JSON.stringify(grant.deployment.installCfg)).not.toContain(
      "private-test-credential",
    );
    expect(
      resolveMcpEnvironment(grant.deployment.installCfg, workspaceId).TOKEN,
    ).toBe("private-test-credential");
    const revision = await db.agentRevision.findFirstOrThrow({
      where: { agentId: result.agentId },
    });
    expect(JSON.stringify(revision.config)).not.toContain(
      "private-test-credential",
    );
  });
  it("rejects changed secret bytes and newly discovered tool grants after preview", async () => {
    const input = remote(request());
    const preview = await previewOmpImport(scope(), input);
    await expect(
      commitOmpImport(scope(), {
        ...input,
        mcpSecrets: { "mcp:fixture": { TOKEN: "changed" } },
        confirmed: true,
        previewChecksum: preview.checksum,
      }),
    ).rejects.toMatchObject({ code: "OMP_IMPORT_PREVIEW_CHANGED" });
    external.tools.push({
      name: "unreviewed",
      inputSchema: { type: "object" },
    });
    const before = await db.agent.count({ where: { workspaceId } });
    await expect(
      commitOmpImport(scope(), {
        ...input,
        confirmed: true,
        previewChecksum: preview.checksum,
      }),
    ).rejects.toMatchObject({ code: "OMP_IMPORT_PREVIEW_CHANGED" });
    expect(await db.agent.count({ where: { workspaceId } })).toBe(before);
  });
  it("rolls back owned resource allocations and leaves no falsely ready Agent after loader failure", async () => {
    publicationBoundaries();
    vi.mocked(runtime.preflightPiSdkCapabilities).mockRejectedValue(
      new Error("PI_EXTENSION_LOAD_FAILED"),
    );
    const before = {
      agents: await db.agent.count({ where: { workspaceId } }),
      skills: await db.installedSkill.count({ where: { workspaceId } }),
    };
    await expect(commit(request())).rejects.toMatchObject({
      code: "OMP_IMPORT_PREPARATION_FAILED",
    });
    expect(await db.agent.count({ where: { workspaceId } })).toBe(
      before.agents,
    );
    expect(await db.installedSkill.count({ where: { workspaceId } })).toBe(
      before.skills,
    );
  });
  it("does not overwrite or delete a reused private plugin when preparation fails", async () => {
    publicationBoundaries();
    const plugin = PrivatePluginInputSchema.parse({
      name: "existing-private",
      runtimeKind: "pi-sdk",
      extensions: ["extension.mjs"],
      files: [
        { path: "extension.mjs", content: "export default function() {}" },
      ],
    });
    const existing = await createPrivatePlugin(workspaceId, userId, plugin);
    const before = await db.marketInstall.findUniqueOrThrow({
      where: { id: existing.installId },
    });
    const input = request();
    input.bundle.plugins = [{ id: "plugin:existing", plugin }];
    vi.mocked(runtime.preflightPiSdkCapabilities).mockRejectedValue(
      new Error("PI_EXTENSION_LOAD_FAILED"),
    );
    await expect(commit(input)).rejects.toMatchObject({
      code: "OMP_IMPORT_PREPARATION_FAILED",
    });
    expect(
      await db.marketInstall.findUniqueOrThrow({
        where: { id: existing.installId },
      }),
    ).toEqual(before);
  });
  it("does not mutate an existing revision or its pinned conversation", async () => {
    publicationBoundaries();
    const old = await createAgent(workspaceId, "Existing");
    const published = await publishFixtureAgentRevision(workspaceId, old.id);
    const revision = await db.agentRevision.findUniqueOrThrow({
      where: { id: published.id },
    });
    const conversation = await createConversation(workspaceId, old.id);
    if (!conversation) throw new Error("Fixture conversation was not created");
    const before = await db.conversation.findUniqueOrThrow({
      where: { id: conversation.id },
    });
    await commit(request());
    expect(
      await db.agentRevision.findUniqueOrThrow({ where: { id: revision.id } }),
    ).toEqual(revision);
    expect(
      await db.conversation.findUniqueOrThrow({
        where: { id: conversation.id },
      }),
    ).toEqual(before);
  });
});
