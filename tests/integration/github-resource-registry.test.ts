// @vitest-environment node
import { createHash, createHmac } from "node:crypto";
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
import {
  getAssistantMarketTemplate,
  installSkillRelease,
  listAssistantMarketTemplates,
} from "@/lib/market/skills";
import {
  createChatAssistant,
  installAssistantMarketRelease,
} from "@/lib/chat/service";
import { ownership } from "@/lib/runtime/ownership-state";
import { POST as webhookPost } from "@/app/api/v1/resource-registries/[registryId]/webhook/route";
import {
  createGithubResourceRegistry,
  deleteGithubResourceRegistry,
  getGithubResourceRegistryWebhookConfiguration,
  listGithubResourceRegistries,
  queueGithubResourceWebhook,
  requestGithubResourceSync,
  runPendingGithubResourceSyncJobs,
} from "@/lib/market/github-registry";

const stamp = `${process.pid}-${Date.now()}`;
let ownerId = "",
  memberId = "",
  outsiderId = "",
  workspaceId = "",
  foreignWorkspaceId = "";
let sequence = 0;
type Snapshot = {
  index: unknown;
  files: Record<string, string>;
  tree?: Array<Record<string, unknown>>;
};
type Source = {
  private: boolean;
  head: string;
  snapshots: Map<string, Snapshot>;
};
const sources = new Map<string, Source>();
const listing = {
  slug: "review",
  name: "Review",
  summary: "Review changes",
  iconUrl: null,
  tags: [],
  author: "Publisher",
};
function descriptor(name = "Review") {
  return JSON.stringify({
    schemaVersion: 1,
    kind: "skill",
    listing: { ...listing, name },
    skill: {
      name,
      slug: "review",
      description: "Review changes",
      userInvocable: true,
      agentInvocable: true,
      effort: "default",
    },
  });
}
function entry(id = "review", version = "1.0.0") {
  return { id, kind: "skill", version, path: `skills/${id}` };
}
function snapshot(
  repository: string,
  resources: unknown[] = [entry()],
  files: Record<string, string> = {
    "skills/review/resource.json": descriptor(),
    "skills/review/SKILL.md": "# Review\nReview changes.",
  },
  privateRepository = false,
) {
  const head = (++sequence).toString(16).padStart(40, "0");
  const source = sources.get(repository) ?? {
    private: privateRepository,
    head,
    snapshots: new Map<string, Snapshot>(),
  };
  source.private = privateRepository;
  source.head = head;
  const value: Snapshot = { index: { schemaVersion: 1, resources }, files };
  source.snapshots.set(head, value);
  sources.set(repository, source);
  return { head, value };
}
function gitBlob(text: string) {
  const bytes = Buffer.from(text);
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}
function mockGithub() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const parts = url.pathname
        .split("/")
        .filter(Boolean)
        .map(decodeURIComponent);
      const repository =
        url.hostname === "api.github.com"
          ? `${parts[1]}/${parts[2]}`
          : `${parts[0]}/${parts[1]}`;
      const source = sources.get(repository);
      if (!source) return new Response(null, { status: 404 });
      if (url.hostname === "api.github.com") {
        if (parts.length === 3)
          return Response.json({ private: source.private });
        if (parts[3] === "commits") return Response.json({ sha: source.head });
        if (parts[3] === "git" && parts[4] === "trees") {
          const snap = source.snapshots.get(parts[5]);
          if (!snap) return new Response(null, { status: 404 });
          const files = {
            "registry.json": JSON.stringify(snap.index),
            ...snap.files,
          };
          return Response.json({
            truncated: false,
            tree:
              snap.tree ??
              Object.entries(files).map(([path, text]) => ({
                type: "blob",
                mode: "100644",
                path,
                size: Buffer.byteLength(text),
                sha: gitBlob(text),
              })),
          });
        }
        if (parts[3] === "git" && parts[4] === "blobs") {
          const auth = new Headers(init?.headers).get("authorization");
          if (!auth) return new Response(null, { status: 401 });
          for (const snap of source.snapshots.values()) {
            for (const text of Object.values({
              "registry.json": JSON.stringify(snap.index),
              ...snap.files,
            })) {
              if (gitBlob(text) === parts[5])
                return Response.json({
                  encoding: "base64",
                  content: Buffer.from(text).toString("base64"),
                  size: Buffer.byteLength(text),
                  sha: parts[5],
                });
            }
          }
        }
      } else if (url.hostname === "raw.githubusercontent.com") {
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        const snap = source.snapshots.get(parts[2]);
        const path = parts.slice(3).join("/");
        if (snap) {
          const text =
            path === "registry.json"
              ? JSON.stringify(snap.index)
              : snap.files[path];
          if (text !== undefined) return new Response(text);
        }
      }
      return new Response(null, { status: 404 });
    }),
  );
}
async function register(
  repository: string,
  visibility = "public",
  token?: string,
) {
  return createGithubResourceRegistry({
    workspaceId,
    userId: ownerId,
    name: repository,
    repository,
    branch: "main",
    visibility,
    token,
  });
}
async function directory(registryId: string) {
  return db.githubRegistryResource.findMany({
    where: { registryId },
    include: { listing: { include: { latestRelease: true } }, versions: true },
    orderBy: { resourceId: "asc" },
  });
}

describe.sequential("durable GitHub registry security and immutable publication", () => {
  beforeAll(async () => {
    const users = await Promise.all(
      ["owner", "member", "outsider"].map((role) =>
        db.user.create({
          data: {
            email: `github-${role}-${stamp}@test.dev`,
            passwordHash: "x",
          },
        }),
      ),
    );
    [ownerId, memberId, outsiderId] = users.map((user) => user.id);
    workspaceId = (
      await db.workspace.create({
        data: {
          slug: `github-${stamp}`,
          name: "Registry",
          ownerId,
          members: {
            create: [
              { userId: ownerId, role: "owner" },
              { userId: memberId, role: "member" },
            ],
          },
        },
      })
    ).id;
    foreignWorkspaceId = (
      await db.workspace.create({
        data: {
          slug: `github-foreign-${stamp}`,
          name: "Foreign",
          ownerId: outsiderId,
        },
      })
    ).id;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await db.chatAssistant.deleteMany({
      where: { workspaceId: { in: [workspaceId, foreignWorkspaceId] } },
    });
    await db.githubResourceRegistry.deleteMany({ where: { workspaceId } });
    await db.marketInstall.deleteMany({
      where: { targetWorkspaceId: { in: [workspaceId, foreignWorkspaceId] } },
    });
    await db.marketListing.updateMany({
      where: { publisherWorkspaceId: workspaceId },
      data: { latestReleaseId: null, pendingReleaseId: null },
    });
    await db.marketRelease.deleteMany({
      where: { listing: { publisherWorkspaceId: workspaceId } },
    });
    await db.marketListing.deleteMany({
      where: { publisherWorkspaceId: workspaceId },
    });
    await db.workspace.deleteMany({
      where: { id: { in: [workspaceId, foreignWorkspaceId] } },
    });
    await db.user.deleteMany({
      where: { id: { in: [ownerId, memberId, outsiderId] } },
    });
    await db.$disconnect();
  });
  it("enforces owner/admin management, member reads and foreign-workspace isolation", async () => {
    snapshot("acme/auth");
    mockGithub();
    const registry = await register("acme/auth");
    for (const userId of [memberId, outsiderId]) {
      await expect(
        createGithubResourceRegistry({
          workspaceId,
          userId,
          name: "bad",
          repository: "acme/auth",
          branch: "main",
          visibility: "public",
        }),
      ).rejects.toMatchObject({ code: "not_authorized" });
      await expect(
        requestGithubResourceSync({
          workspaceId,
          userId,
          registryId: registry.id,
        }),
      ).rejects.toMatchObject({ code: "not_authorized" });
      await expect(
        getGithubResourceRegistryWebhookConfiguration({
          workspaceId,
          userId,
          registryId: registry.id,
        }),
      ).rejects.toMatchObject({ code: "not_authorized" });
    }
    await expect(
      listGithubResourceRegistries({ workspaceId, userId: outsiderId }),
    ).rejects.toMatchObject({ code: "not_authorized" });
    expect(
      await listGithubResourceRegistries({ workspaceId, userId: memberId }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: registry.id, hasCredentials: false }),
      ]),
    );
    await expect(
      requestGithubResourceSync({
        workspaceId: foreignWorkspaceId,
        userId: outsiderId,
        registryId: registry.id,
      }),
    ).rejects.toMatchObject({ code: "registry_not_found" });
  });
  it("isolates webhook keys between workspaces, requires a master and deduplicates valid deliveries", async () => {
    snapshot("acme/webhook");
    mockGithub();
    vi.stubEnv(
      "TOOLPLANE_RESOURCE_REGISTRY_WEBHOOK_SECRET",
      "server-only-webhook-master",
    );
    const registryA = await register("acme/webhook");
    const registryB = await createGithubResourceRegistry({
      workspaceId: foreignWorkspaceId,
      userId: outsiderId,
      name: "foreign webhook",
      repository: "acme/webhook",
      branch: "main",
      visibility: "public",
    });
    try {
      const configA = await getGithubResourceRegistryWebhookConfiguration({
        workspaceId,
        userId: ownerId,
        registryId: registryA.id,
      });
      const configB = await getGithubResourceRegistryWebhookConfiguration({
        workspaceId: foreignWorkspaceId,
        userId: outsiderId,
        registryId: registryB.id,
      });
      expect(configA.secret).not.toBe(configB.secret);
      expect(configB.secret).not.toBe(
        process.env.TOOLPLANE_RESOURCE_REGISTRY_WEBHOOK_SECRET,
      );
      await expect(
        getGithubResourceRegistryWebhookConfiguration({
          workspaceId,
          userId: ownerId,
          registryId: registryB.id,
        }),
      ).rejects.toMatchObject({ code: "registry_not_found" });
      const body = JSON.stringify({
        repository: { full_name: "acme/webhook" },
        ref: "refs/heads/main",
        after: "a".repeat(40),
      });
      const send = (secret: string) =>
        webhookPost(
          new Request(`http://localhost${configB.path}`, {
            method: "POST",
            body,
            headers: {
              "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
              "x-github-event": "push",
              "x-github-delivery": "scoped-delivery",
            },
          }),
          { params: Promise.resolve({ registryId: registryB.id }) },
        );
      expect((await send(configA.secret)).status).toBe(401);
      expect(
        await db.githubResourceSyncJob.count({
          where: { registryId: registryB.id },
        }),
      ).toBe(1);
      vi.stubEnv("TOOLPLANE_RESOURCE_REGISTRY_WEBHOOK_SECRET", "");
      expect((await send(configB.secret)).status).toBe(503);
      vi.stubEnv(
        "TOOLPLANE_RESOURCE_REGISTRY_WEBHOOK_SECRET",
        "server-only-webhook-master",
      );
      const accepted = await send(configB.secret);
      expect(accepted.status).toBe(202);
      const replay = await send(configB.secret);
      expect(replay.status).toBe(202);
      expect(await replay.json()).toEqual(await accepted.json());
      expect(
        await db.githubResourceSyncJob.count({
          where: { registryId: registryB.id },
        }),
      ).toBe(2);
    } finally {
      await deleteGithubResourceRegistry({
        workspaceId,
        userId: ownerId,
        registryId: registryA.id,
      });
      await deleteGithubResourceRegistry({
        workspaceId: foreignWorkspaceId,
        userId: outsiderId,
        registryId: registryB.id,
      });
    }
  });
  it("leaves durable work queued while the runtime owner is blocked", async () => {
    snapshot("acme/blocked");
    mockGithub();
    const registry = await register("acme/blocked");
    const previous = ownership.status;
    vi.stubEnv("TOOLPLANE_TEST_RUNTIME_OWNER", "1");
    ownership.status = "blocked";
    try {
      await runPendingGithubResourceSyncJobs();
      expect(await directory(registry.id)).toHaveLength(0);
      expect(
        await db.githubResourceSyncJob.count({
          where: { registryId: registry.id, status: "pending" },
        }),
      ).toBe(1);
    } finally {
      ownership.status = previous;
    }
  });
  it("publishes one pinned directory, reuses identical versions and retains the previous directory on malformed/colliding updates", async () => {
    const initial = snapshot("acme/atomic");
    mockGithub();
    const registry = await register("acme/atomic");
    await runPendingGithubResourceSyncJobs();
    const before = await directory(registry.id);
    expect(before).toHaveLength(1);
    const releaseId = before[0].listing?.latestReleaseId;
    expect(before[0].versions[0]).toMatchObject({
      version: "1.0.0",
      sourceCommit: initial.head,
    });
    if (!releaseId)
      throw new Error("The valid directory did not publish a release");
    await installSkillRelease({
      releaseId,
      targetWorkspaceId: foreignWorkspaceId,
      installedById: outsiderId,
      idempotencyKey: `registry-pin-${stamp}`,
    });
    snapshot("acme/atomic");
    await requestGithubResourceSync({
      workspaceId,
      userId: ownerId,
      registryId: registry.id,
    });
    await runPendingGithubResourceSyncJobs();
    expect((await directory(registry.id))[0].listing?.latestReleaseId).toBe(
      releaseId,
    );
    expect((await directory(registry.id))[0].versions).toHaveLength(1);
    snapshot("acme/atomic", [entry(), entry("broken")]);
    await requestGithubResourceSync({
      workspaceId,
      userId: ownerId,
      registryId: registry.id,
    });
    await runPendingGithubResourceSyncJobs();
    expect((await directory(registry.id))[0].listing?.latestReleaseId).toBe(
      releaseId,
    );
    expect(
      (
        await db.githubResourceRegistry.findUniqueOrThrow({
          where: { id: registry.id },
        })
      ).status,
    ).toBe("error");
    snapshot("acme/atomic", [entry()], {
      "skills/review/resource.json": descriptor(),
      "skills/review/SKILL.md": "Changed without version bump",
    });
    await requestGithubResourceSync({
      workspaceId,
      userId: ownerId,
      registryId: registry.id,
    });
    await runPendingGithubResourceSyncJobs();
    const failed = await db.githubResourceRegistry.findUniqueOrThrow({
      where: { id: registry.id },
    });
    expect(failed.error).toBe("resource_version_conflict");
    expect((await directory(registry.id))[0].listing?.latestReleaseId).toBe(
      releaseId,
    );
    expect(
      await db.githubResourceSyncJob.count({
        where: { registryId: registry.id, status: "failed" },
      }),
    ).toBe(2);
    snapshot("acme/atomic", []);
    await requestGithubResourceSync({
      workspaceId,
      userId: ownerId,
      registryId: registry.id,
    });
    await runPendingGithubResourceSyncJobs();
    expect((await directory(registry.id))[0]).toMatchObject({
      active: false,
      listing: { status: "draft" },
    });
    expect(
      await db.marketRelease.findUnique({ where: { id: releaseId ?? "" } }),
    ).not.toBeNull();
    expect(
      await db.marketInstall.findFirst({
        where: { targetWorkspaceId: foreignWorkspaceId },
      }),
    ).toMatchObject({
      currentReleaseId: releaseId,
      requestedReleaseId: releaseId,
    });
    snapshot("acme/atomic");
    await requestGithubResourceSync({
      workspaceId,
      userId: ownerId,
      registryId: registry.id,
    });
    await runPendingGithubResourceSyncJobs();
    expect((await directory(registry.id))[0]).toMatchObject({
      active: true,
      listing: { status: "published", latestReleaseId: releaseId },
    });
    expect(
      await db.marketInstall.findFirst({
        where: { targetWorkspaceId: foreignWorkspaceId },
      }),
    ).toMatchObject({
      currentReleaseId: releaseId,
      requestedReleaseId: releaseId,
    });
  });
  it("preserves administrator takedowns across unchanged, newer, removed and re-added source entries", async () => {
    snapshot("acme/moderated");
    mockGithub();
    const registry = await register("acme/moderated");
    await runPendingGithubResourceSyncJobs();
    const resource = (await directory(registry.id))[0];
    if (!resource.listingId)
      throw new Error("The valid directory did not create a listing");
    await db.marketListing.update({
      where: { id: resource.listingId },
      data: { status: "disabled" },
    });
    const sync = async () => {
      await requestGithubResourceSync({
        workspaceId,
        userId: ownerId,
        registryId: registry.id,
      });
      await runPendingGithubResourceSyncJobs();
      expect((await directory(registry.id))[0].listing?.status).toBe(
        "disabled",
      );
    };
    snapshot("acme/moderated");
    await sync();
    snapshot("acme/moderated", [entry("review", "1.1.0")], {
      "skills/review/resource.json": descriptor(),
      "skills/review/SKILL.md": "# Review\nUpdated resource.",
    });
    await sync();
    expect((await directory(registry.id))[0].versions).toHaveLength(2);
    snapshot("acme/moderated", []);
    await sync();
    expect((await directory(registry.id))[0].active).toBe(false);
    snapshot("acme/moderated");
    await sync();
    expect((await directory(registry.id))[0].active).toBe(true);
    await deleteGithubResourceRegistry({
      workspaceId,
      userId: ownerId,
      registryId: registry.id,
    });
    expect((await directory(registry.id))[0].listing?.status).toBe("disabled");
  });
  it("supersedes stale queued work and deduplicates replayed deliveries without reverting to an old commit", async () => {
    snapshot("acme/deliveries");
    mockGithub();
    const registry = await register("acme/deliveries");
    const current = snapshot("acme/deliveries");
    const first = await queueGithubResourceWebhook({
      registryId: registry.id,
      repository: "acme/deliveries",
      ref: "refs/heads/main",
      deliveryId: "delivery-1",
    });
    const replay = await queueGithubResourceWebhook({
      registryId: registry.id,
      repository: "acme/deliveries",
      ref: "refs/heads/main",
      deliveryId: "delivery-1",
    });
    expect(replay).toEqual(first);
    await runPendingGithubResourceSyncJobs();
    expect(
      await db.githubResourceSyncJob.count({
        where: { registryId: registry.id, status: "superseded" },
      }),
    ).toBe(1);
    expect(
      (
        await db.githubResourceRegistry.findUniqueOrThrow({
          where: { id: registry.id },
        })
      ).lastAppliedCommit,
    ).toBe(current.head);
    await queueGithubResourceWebhook({
      registryId: registry.id,
      repository: "acme/deliveries",
      ref: "refs/heads/main",
      deliveryId: "late-old-push",
    });
    await runPendingGithubResourceSyncJobs();
    expect((await directory(registry.id))[0].versions).toHaveLength(1);
    expect(
      (
        await db.githubResourceRegistry.findUniqueOrThrow({
          where: { id: registry.id },
        })
      ).lastAppliedCommit,
    ).toBe(current.head);
  });
  it("rejects missing or malformed config MCP tools/list snapshots without changing the published directory", async () => {
    const repository = "acme/mcp-catalog";
    const mcpEntry = {
      id: "reviewed-mcp",
      kind: "mcp",
      version: "1.0.0",
      path: "mcp/reviewed",
    };
    const tool = {
      name: "inspect",
      inputSchema: { type: "object", properties: {} },
    };
    function mcpDescriptor(toolCatalog: unknown) {
      return JSON.stringify({
        schemaVersion: 1,
        kind: "mcp",
        listing: { ...listing, slug: "reviewed-mcp", name: "Reviewed MCP" },
        mcp: {
          name: "Reviewed MCP",
          slug: "reviewed-mcp",
          description: null,
          author: null,
          iconUrl: null,
          readme: null,
          recipe: {
            source: "config",
            ref: "npx",
            command: "npx",
            args: ["--yes", "@modelcontextprotocol/server-memory@2.0.0"],
            env: [],
          },
          toolExposure: "allowlist",
          allowedTools: [],
          toolCatalog,
        },
      });
    }
    const files = {
      "skills/review/resource.json": descriptor(),
      "skills/review/SKILL.md": "# Review\nReview changes.",
      "mcp/reviewed/resource.json": mcpDescriptor([tool]),
    };
    const initial = snapshot(repository, [entry(), mcpEntry], files);
    mockGithub();
    const registry = await register(repository);
    await runPendingGithubResourceSyncJobs();
    const before = await directory(registry.id);
    expect(before).toHaveLength(2);
    for (const toolCatalog of [
      undefined,
      null,
      [{ name: "inspect" }],
      [tool, tool],
    ]) {
      snapshot(
        repository,
        [entry("review", "1.0.1"), { ...mcpEntry, version: "1.0.1" }],
        {
          ...files,
          "skills/review/SKILL.md":
            "This sibling update must not publish on invalid MCP admission.",
          "mcp/reviewed/resource.json": mcpDescriptor(toolCatalog),
        },
      );
      await requestGithubResourceSync({
        workspaceId,
        userId: ownerId,
        registryId: registry.id,
      });
      await runPendingGithubResourceSyncJobs();
      expect(await directory(registry.id)).toEqual(before);
      expect(
        await db.githubResourceRegistry.findUniqueOrThrow({
          where: { id: registry.id },
        }),
      ).toMatchObject({
        status: "error",
        error: "resource_mcp_tool_catalog_invalid",
        lastAppliedCommit: initial.head,
      });
    }
    expect(
      await db.githubResourceSyncJob.count({
        where: {
          registryId: registry.id,
          status: "failed",
          error: "resource_mcp_tool_catalog_invalid",
        },
      }),
    ).toBe(4);
  });
  it("creates Assistants from an own-workspace private preset but denies foreign workspace access", async () => {
    snapshot(
      "acme/private-assistant",
      [
        {
          id: "private-assistant",
          kind: "assistant",
          version: "1.0.0",
          path: "assistants/private",
        },
      ],
      {
        "assistants/private/resource.json": JSON.stringify({
          schemaVersion: 1,
          kind: "assistant",
          listing: {
            ...listing,
            slug: "private-assistant",
            name: "Private assistant",
          },
          assistant: {
            name: "Private assistant",
            systemPrompt: "Use only the supplied private workspace context.",
            maxSteps: 7,
            modelRequirement: null,
            modelParameters: null,
            mcpRequirements: [],
          },
        }),
      },
    );
    mockGithub();
    const registry = await register("acme/private-assistant", "private");
    await runPendingGithubResourceSyncJobs();
    const resource = (await directory(registry.id))[0];
    const releaseId = resource.listing?.latestReleaseId;
    expect(releaseId).toBeTruthy();
    if (!releaseId)
      throw new Error("Private Assistant release was not published");
    const viewer = { workspaceId, userId: memberId };
    const template = await getAssistantMarketTemplate(releaseId, viewer);
    expect(template?.releaseId).toBe(releaseId);
    expect(
      (await listAssistantMarketTemplates({ viewer })).some(
        (candidate) => candidate.releaseId === releaseId,
      ),
    ).toBe(true);
    const created = await createChatAssistant(memberId, {
      workspaceId,
      marketTemplateReleaseId: releaseId,
      name: "Customized private preset",
      systemPrompt: template?.manifest.assistant.systemPrompt,
      maxSteps: template?.manifest.assistant.maxSteps,
    });
    expect(
      await db.chatAssistant.findUnique({ where: { id: created.id } }),
    ).toMatchObject({
      workspaceId,
      name: "Customized private preset",
      marketTemplateReleaseId: releaseId,
      systemPrompt: "Use only the supplied private workspace context.",
      maxSteps: 7,
      currentRevisionVersion: 1,
    });
    expect(
      await db.chatAssistantRevision.findFirst({
        where: { assistantId: created.id, version: 1 },
      }),
    ).toMatchObject({
      config: {
        systemPrompt: "Use only the supplied private workspace context.",
        maxSteps: 7,
      },
    });
    const installed = await installAssistantMarketRelease(ownerId, {
      workspaceId,
      releaseId,
    });
    expect(installed).toMatchObject({
      name: "Private assistant",
      marketTemplateReleaseId: releaseId,
    });
    expect(await getAssistantMarketTemplate(releaseId)).toBeNull();
    expect(
      await getAssistantMarketTemplate(releaseId, {
        workspaceId,
        userId: outsiderId,
      }),
    ).toBeNull();
    expect(
      await getAssistantMarketTemplate(releaseId, {
        workspaceId: foreignWorkspaceId,
        userId: outsiderId,
      }),
    ).toBeNull();
    await expect(
      createChatAssistant(outsiderId, {
        workspaceId: foreignWorkspaceId,
        name: "Forbidden",
        marketTemplateReleaseId: releaseId,
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: "Assistant market template not found",
    });
    await expect(
      installAssistantMarketRelease(outsiderId, {
        workspaceId: foreignWorkspaceId,
        releaseId,
      }),
    ).rejects.toMatchObject({
      status: 404,
      message: "Assistant market template not found",
    });
    await expect(
      createChatAssistant(outsiderId, {
        workspaceId,
        name: "Forged workspace",
        marketTemplateReleaseId: releaseId,
      }),
    ).rejects.toMatchObject({ status: 404, message: "Workspace not found" });
    expect(
      await db.chatAssistant.count({
        where: { workspaceId: foreignWorkspaceId },
      }),
    ).toBe(0);
  });
  it("encrypts private credentials, keeps them out of releases and rejects public roots or external private sources", async () => {
    snapshot("acme/private", [entry()], undefined, true);
    mockGithub();
    const token = "github_pat_registry_test_credential";
    await expect(
      register("acme/private", "public", token),
    ).rejects.toMatchObject({
      code: "private_repository_requires_private_visibility",
    });
    const registry = await register("acme/private", "private", token);
    await runPendingGithubResourceSyncJobs();
    const stored = await db.githubResourceRegistry.findUniqueOrThrow({
      where: { id: registry.id },
    });
    expect(JSON.stringify(stored.credentials)).not.toContain(token);
    const resource = (await directory(registry.id))[0];
    expect(resource.listing?.visibility).toBe("private");
    expect(
      JSON.stringify(resource.listing?.latestRelease?.manifest),
    ).not.toContain(token);
    const external = snapshot("acme/external", [entry()], undefined, true);
    snapshot("acme/public", [
      {
        ...entry(),
        source: {
          repository: "acme/external",
          commit: external.head,
          path: "skills/review",
        },
      },
    ]);
    const publicRegistry = await register("acme/public");
    await runPendingGithubResourceSyncJobs();
    expect(
      (
        await db.githubResourceRegistry.findUniqueOrThrow({
          where: { id: publicRegistry.id },
        })
      ).error,
    ).toBe("private_repository_requires_private_visibility");
    expect(await directory(publicRegistry.id)).toHaveLength(0);
    await deleteGithubResourceRegistry({
      workspaceId,
      userId: ownerId,
      registryId: registry.id,
    });
    expect(
      (
        await db.githubResourceRegistry.findUniqueOrThrow({
          where: { id: registry.id },
        })
      ).credentials,
    ).toBeNull();
    expect(
      await db.marketRelease.findUnique({
        where: { id: resource.listing?.latestReleaseId ?? "" },
      }),
    ).not.toBeNull();
  });
});
