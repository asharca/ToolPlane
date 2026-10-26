// @vitest-environment node
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { GET, POST } from "@/app/api/v1/agents/[agentId]/composer/route";
import {
  GET as listPrompts,
  POST as mutatePrompt,
} from "@/app/api/v1/agents/[agentId]/composer-prompts/route";
import { mcpRpc } from "@/lib/process/mcp-client";
import { workMessageParts } from "@/lib/attachments/work";
import { uiMessagesToPi } from "@/lib/agents/native";
import { publishFixtureAgentRevision } from "./agent-revision-fixture";
import type { SessionMcpContext } from "@/lib/process/session-mcp";
import type * as SessionMcpModule from "@/lib/process/session-mcp";
import type * as SupervisorModule from "@/lib/process/supervisor";

const identity = vi.hoisted(() => ({ id: "" }));
const transport = vi.hoisted(() => ({ resource: vi.fn() }));
vi.mock("@/lib/auth/request-user", () => ({
  resolveRequestUser: async () => ({ id: identity.id }),
}));
vi.mock("@/lib/process/mcp-client", () => ({ mcpRpc: vi.fn() }));
vi.mock("@/lib/process/supervisor", async (original) => ({
  ...(await original<typeof SupervisorModule>()),
  liveStatus: () => "running",
}));
// Composer authority is real; the scoped MCP transport is a deterministic resource server port.
vi.mock("@/lib/process/session-mcp", async (original) => ({
  ...(await original<typeof SessionMcpModule>()),
  sessionMcpRequest: transport.resource,
}));

let workspaceId: string,
  agentId: string,
  otherAgentId: string,
  foreignWorkspaceId: string,
  foreignAgentId: string;
let sandboxId: string,
  sandboxDeploymentId: string,
  otherSandboxId: string,
  resourceDeploymentId: string;
let conversationId: string,
  channelConversationId: string,
  excludedConversationId: string,
  foreignConversationId: string;
let skillId: string, temp: string, root: string;
let agentRevisionId: string;

const params = (id = agentId) => ({ params: Promise.resolve({ agentId: id }) });
const request = (body: unknown) =>
  new Request("http://local/composer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const resolve = (body: Record<string, unknown>, id = agentId) =>
  POST(
    request({ sandboxId, conversationId: excludedConversationId, ...body }),
    params(id),
  );
const list = (query: Record<string, string>, id = agentId) =>
  GET(
    new Request(
      `http://local/composer?${new URLSearchParams({ sandboxId, conversationId: excludedConversationId, section: "references", ...query })}`,
    ),
    params(id),
  );

beforeAll(async () => {
  temp = await mkdtemp(join(tmpdir(), "toolplane-composer-"));
  root = join(temp, "workspace");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "guide.md"),
    "The sandbox plan uses the existing sidebar.",
  );
  await writeFile(join(root, "long.txt"), "bounded ".repeat(5000));
  await writeFile(join(root, "binary.dat"), Buffer.from([0, 1, 2]));
  await writeFile(join(temp, "outside.txt"), "Outside the sandbox");
  await symlink(join(temp, "outside.txt"), join(root, "escape.txt"));
  const user = await db.user.create({
    data: {
      email: `composer-${Date.now()}@test.invalid`,
      passwordHash: "unused",
    },
  });
  identity.id = user.id;
  workspaceId = (
    await db.workspace.create({
      data: {
        ownerId: user.id,
        slug: `composer-${Date.now()}`,
        name: "Composer",
      },
    })
  ).id;
  const foreignUser = await db.user.create({
    data: {
      email: `composer-other-${Date.now()}@test.invalid`,
      passwordHash: "unused",
    },
  });
  foreignWorkspaceId = (
    await db.workspace.create({
      data: {
        ownerId: foreignUser.id,
        slug: `composer-other-${Date.now()}`,
        name: "Other composer",
      },
    })
  ).id;
  const createAgent = async (slug: string, workspace = workspaceId) => {
    const provider = await db.modelProvider.create({
      data: {
        workspaceId: workspace,
        name: `${slug}-model`,
        format: "openai",
        baseUrl: "https://model.fixture.invalid/v1",
        apiKey: "fixture-key",
        models: ["fixture"],
      },
    });
    return (
      await db.agent.create({
        data: {
          workspaceId: workspace,
          slug,
          name: slug,
          runtimeKind: "pi-sdk",
          providerId: provider.id,
          model: "fixture",
        },
      })
    ).id;
  };
  agentId = await createAgent("primary");
  otherAgentId = await createAgent("other");
  foreignAgentId = await createAgent("foreign", foreignWorkspaceId);
  const createSandbox = async (slug: string) => {
    const deployment = await db.deployment.create({
      data: { workspaceId, name: slug, status: "running" },
    });
    return db.sandbox.create({
      data: {
        workspaceId,
        deploymentId: deployment.id,
        slug,
        name: slug,
        kind: "docker",
      },
    });
  };
  const sandbox = await createSandbox("current");
  sandboxId = sandbox.id;
  sandboxDeploymentId = sandbox.deploymentId;
  otherSandboxId = (await createSandbox("other")).id;
  const template = await createSandbox("template");
  await db.agentSandbox.create({
    data: { agentId, sandboxId: template.id, isDefault: true },
  });
  const channel = await db.agentChannelConnection.create({
    data: {
      workspaceId,
      agentId,
      sandboxId,
      platform: "weixin",
      name: "Test WeChat",
      inboundTokenHash: `composer-${Date.now()}`,
      inboundTokenPrefix: "test",
      inboundTokenSecret: {},
    },
  });
  skillId = (
    await db.installedSkill.create({
      data: {
        workspaceId,
        name: "Review",
        slug: "review",
        content: "Check the release plan.",
        source: "custom",
      },
    })
  ).id;
  await db.agentSkill.create({ data: { agentId, installedSkillId: skillId } });
  const hiddenSkill = await db.installedSkill.create({
    data: {
      workspaceId,
      name: "Hidden",
      slug: "hidden",
      content: "Hidden content",
      source: "custom",
      userInvocable: false,
    },
  });
  await db.agentSkill.create({
    data: { agentId, installedSkillId: hiddenSkill.id },
  });
  resourceDeploymentId = (
    await db.deployment.create({
      data: {
        workspaceId,
        name: "Resources",
        status: "running",
        source: "remote",
        sourceRef: "https://resources.fixture.invalid/mcp",
        installCfg: { transport: "streamable-http" },
      },
    })
  ).id;
  await db.agentServer.create({
    data: { agentId, deploymentId: resourceDeploymentId, allowedToolNames: [] },
  });
  agentRevisionId = (await publishFixtureAgentRevision(workspaceId, agentId))
    .id;
  const createSession = async (title: string, sandbox: string) => {
    const conversation = await db.conversation.create({
      data: {
        agentId,
        title,
        sandboxId: sandbox,
        agentRevisionId,
        legacyRevisionUnresolved: false,
        messages: {
          create: [
            { role: "user", parts: [{ type: "text", text: title }] },
            {
              role: "assistant",
              parts: [
                { type: "text", text: "Preserve the release checklist." },
              ],
            },
          ],
        },
      },
    });
    await db.workSession.create({
      data: {
        agentId,
        workspaceId,
        sandboxId: sandbox,
        conversationId: conversation.id,
        agentRevisionId,
        legacyRevisionUnresolved: false,
        title,
        status: "completed",
        runtimeKind: "pi-sdk",
      },
    });
    return conversation.id;
  };
  conversationId = await createSession(
    "Previous task",
    (await createSandbox("previous-task")).id,
  );
  excludedConversationId = await createSession("Current task", sandboxId);
  foreignConversationId = await createSession(
    "Other sandbox task",
    otherSandboxId,
  );
  channelConversationId = (
    await db.conversation.create({
      data: {
        agentId,
        title: "WeChat history",
        runtimeSessionKey: `channel:${channel.id}:msg:weixin:dm:contact`,
        sandboxId: (await createSandbox("channel-history")).id,
        agentRevisionId,
        legacyRevisionUnresolved: false,
        messages: {
          create: [
            {
              role: "user",
              parts: [{ type: "text", text: "Channel request" }],
            },
          ],
        },
      },
    })
  ).id;
  transport.resource.mockImplementation(
    async (
      context: SessionMcpContext,
      deploymentId: string,
      method: string,
    ) => {
      expect(context).toEqual({
        workspaceId,
        agentId,
        agentRevisionId,
        conversationId: excludedConversationId,
      });
      expect(deploymentId).toBe(resourceDeploymentId);
      if (method === "resources/list")
        return {
          resources: [{ uri: "test://plan", name: "Release resource" }],
        };
      if (method === "resources/read")
        return {
          contents: [
            { uri: "test://plan", text: "Resource release checklist." },
          ],
        };
      throw new Error(`Unexpected scoped method ${method}`);
    },
  );
  vi.mocked(mcpRpc).mockImplementation(async (deploymentId, method, input) => {
    expect(method).toBe("tools/call");
    expect(deploymentId).toBe(sandboxDeploymentId);
    const args = input?.arguments as { runtime: string; args: string[] };
    expect(args.runtime).toBe("node");
    try {
      const result = await promisify(execFile)(process.execPath, args.args, {
        cwd: root,
        timeout: 15_000,
        maxBuffer: 256 * 1024,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ exitCode: 0, stdout: result.stdout }),
          },
        ],
      };
    } catch {
      return {
        content: [
          { type: "text", text: JSON.stringify({ exitCode: 1, stdout: "" }) },
        ],
      };
    }
  });
});

afterAll(async () => {
  const workspaces = await db.workspace.findMany({
    where: { id: { in: [workspaceId, foreignWorkspaceId] } },
    select: { ownerId: true },
  });
  await db.workspace.deleteMany({
    where: { id: { in: [workspaceId, foreignWorkspaceId] } },
  });
  await db.user.deleteMany({
    where: { id: { in: workspaces.map((workspace) => workspace.ownerId) } },
  });
  await rm(temp, { recursive: true, force: true });
  await db.$disconnect();
});

describe("Agent composer scope and references", () => {
  it("lists current-session files and associated channel history without exposing other Work sandboxes", async () => {
    const response = await list({
      excludeConversationId: excludedConversationId,
    });
    expect(response.status).toBe(200);
    const { items } = await response.json();
    const ids = items.map((item: { id: string }) => item.id);
    expect(ids).not.toContain(conversationId);
    expect(ids).toContain(channelConversationId);
    expect(ids).not.toContain(excludedConversationId);
    expect(ids).not.toContain(foreignConversationId);
    expect(ids).not.toContain("escape.txt");
    const searched = await list({ query: "guide.md" });
    expect((await searched.json()).items).toEqual([
      { kind: "file", id: "src/guide.md", label: "src/guide.md" },
    ]);
  });

  it("resolves file and session text into persisted model-readable parts without exposing other sandboxes", async () => {
    const file = await resolve({ kind: "file", id: "src/guide.md" });
    expect(file.status).toBe(200);
    const reference = await file.json();
    expect(reference.text).toContain("/workspace/src/guide.md");
    expect(reference.text).toContain("existing sidebar");
    const parts = workMessageParts("Review this", [], [reference]);
    expect(parts[1]).toMatchObject({
      reference: { label: "src/guide.md", kind: "file" },
    });
    expect(JSON.stringify(uiMessagesToPi([{ role: "user", parts }]))).toContain(
      "existing sidebar",
    );
    const session = await resolve({
      kind: "session",
      id: excludedConversationId,
    });
    expect((await session.json()).text).toContain("release checklist");
    expect(
      (await resolve({ kind: "session", id: conversationId })).status,
    ).toBe(404);
    const channel = await resolve({
      kind: "session",
      id: channelConversationId,
    });
    expect((await channel.json()).text).toContain("Channel request");
    expect(
      (await resolve({ kind: "session", id: foreignConversationId })).status,
    ).toBe(404);
    expect((await resolve({ kind: "file", id: "../outside.txt" })).status).toBe(
      400,
    );
    expect((await resolve({ kind: "file", id: "escape.txt" })).status).toBe(
      422,
    );
    expect((await resolve({ kind: "file", id: "binary.dat" })).status).toBe(
      422,
    );
    expect((await resolve({ kind: "file", id: "long.txt" })).status).toBe(200);
    expect(
      (await (await resolve({ kind: "file", id: "long.txt" })).json()).text,
    ).toContain("[Truncated]");
  });

  it("enforces Agent and workspace access for all catalogs and reads", async () => {
    expect((await list({ sandboxId: otherSandboxId })).status).toBe(404);
    expect((await list({}, foreignAgentId)).status).toBe(404);
    expect((await list({ section: "mcp" }, foreignAgentId)).status).toBe(404);
    expect((await list({ workSessionId: "missing-work" })).status).toBe(404);
    expect(
      (await resolve({ kind: "file", id: "src/guide.md" }, otherAgentId))
        .status,
    ).toBe(404);
    expect(
      (
        await resolve({
          kind: "resource",
          id: "test://plan",
          deploymentId: sandboxDeploymentId,
        })
      ).status,
    ).toBe(404);
  });

  it("offers only attached user-invocable skills and reads attached MCP resources", async () => {
    const skills = (await (await list({ section: "skills" })).json()).items;
    expect(skills.map((item: { id: string }) => item.id)).toEqual([skillId]);
    expect(
      (await (await resolve({ kind: "skill", id: skillId })).json()).text,
    ).toContain("Check the release plan");
    expect(
      (await resolve({ kind: "skill", id: skillId }, otherAgentId)).status,
    ).toBe(404);
    const resources = (await (await list({ section: "resources" })).json())
      .items;
    expect(resources).toMatchObject([
      { id: "test://plan", deploymentId: resourceDeploymentId },
    ]);
    expect(
      (
        await (
          await resolve({
            kind: "resource",
            id: "test://plan",
            deploymentId: resourceDeploymentId,
          })
        ).json()
      ).text,
    ).toContain("Resource release checklist");
    const mcp = (await (await list({ section: "mcp" })).json()).items;
    expect(mcp).toEqual([
      { id: resourceDeploymentId, label: "Resources", status: "available" },
    ]);
  });

  it("persists prompt CRUD per Agent and rejects cross-Agent edits and invalid values", async () => {
    const created = await mutatePrompt(
      request({
        action: "save",
        title: "Review",
        content: "Review the current plan.",
      }),
      params(),
    );
    expect(created.status).toBe(201);
    const { id } = await created.json();
    const listed = await listPrompts(
      new Request("http://local/prompts"),
      params(),
    );
    expect((await listed.json()).prompts).toMatchObject([
      { id, title: "Review" },
    ]);
    expect(
      (
        await mutatePrompt(
          request({
            action: "save",
            id,
            title: "Changed",
            content: "Invalid cross-Agent edit",
          }),
          params(otherAgentId),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await mutatePrompt(
          request({ action: "delete", id }),
          params(otherAgentId),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await mutatePrompt(
          request({ action: "save", title: "", content: "Empty name" }),
          params(),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await mutatePrompt(
          request({
            action: "save",
            id,
            title: "Updated review",
            content: "Keep exact paths.",
          }),
          params(),
        )
      ).status,
    ).toBe(200);
    expect(
      (await db.agentComposerPrompt.findUnique({ where: { id } }))?.content,
    ).toBe("Keep exact paths.");
    expect(
      (await mutatePrompt(request({ action: "delete", id }), params())).status,
    ).toBe(200);
    expect(
      await db.agentComposerPrompt.findUnique({ where: { id } }),
    ).toBeNull();
  });
});

describe("Pinned composer session authority", () => {
  it("rejects missing or unresolved historical pins without falling back to the Agent template", async () => {
    const beforeFiles = vi.mocked(mcpRpc).mock.calls.length;
    const beforeResources = transport.resource.mock.calls.length;
    const missing = await GET(
      new Request(
        `http://local/composer?section=references&sandboxId=${sandboxId}`,
      ),
      params(),
    );
    expect(missing.status).toBe(400);
    const historyDeployment = await db.deployment.create({
      data: { workspaceId, name: "Unresolved history", status: "stopped" },
    });
    const historySandbox = await db.sandbox.create({
      data: {
        workspaceId,
        name: "Unresolved history",
        slug: "unresolved-history",
        kind: "docker",
        deploymentId: historyDeployment.id,
      },
    });
    const history = await db.conversation.create({
      data: {
        agentId,
        sandboxId: historySandbox.id,
        title: "Retained unresolved history",
        agentRevisionId: null,
        legacyRevisionUnresolved: true,
      },
    });
    expect(
      (await list({ conversationId: history.id, sandboxId: historySandbox.id }))
        .status,
    ).toBe(410);
    expect(vi.mocked(mcpRpc)).toHaveBeenCalledTimes(beforeFiles);
    expect(transport.resource).toHaveBeenCalledTimes(beforeResources);
  });

  it("intersects pinned MCP resource sources with live attachment revocation", async () => {
    await db.agentServer.delete({
      where: {
        agentId_deploymentId: { agentId, deploymentId: resourceDeploymentId },
      },
    });
    try {
      const resources = await list({ section: "resources" });
      expect(resources.status).toBe(200);
      expect((await resources.json()).items).toEqual([]);
      expect(
        (
          await resolve({
            kind: "resource",
            id: "test://plan",
            deploymentId: resourceDeploymentId,
          })
        ).status,
      ).toBe(404);
      const sources = await list({ section: "mcp" });
      expect(sources.status).toBe(200);
      expect((await sources.json()).items).toEqual([]);
    } finally {
      await db.agentServer.create({
        data: {
          agentId,
          deploymentId: resourceDeploymentId,
          allowedToolNames: [],
        },
      });
    }
  });
});
