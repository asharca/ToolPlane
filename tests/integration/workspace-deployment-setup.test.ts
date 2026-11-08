// @vitest-environment node
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { db } from "@/lib/db";
import {
  resolveMcpEnvironment,
  sealMcpEnvironment,
} from "@/lib/process/mcp-credentials";
import type { Prisma } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  startProcess: vi.fn(),
  stopProcess: vi.fn(),
  restartProcess: vi.fn(),
  killProcess: vi.fn(),
  liveStatus: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/lib/auth/current-user", () => ({
  getCurrentUser: mocks.getCurrentUser,
}));
vi.mock("@/lib/process/supervisor", () => ({
  startProcess: mocks.startProcess,
  stopProcess: mocks.stopProcess,
  restartProcess: mocks.restartProcess,
  killProcess: mocks.killProcess,
  liveStatus: mocks.liveStatus,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import {
  cloneDeploymentAction,
  deployServerAction,
  revealDeploymentEnvAction,
  setDeploymentEnvAction,
} from "@/lib/workspace/actions";

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const email = `workspace-deployment-setup-${stamp}@test.dev`;
const workspaceSlug = `workspace-deployment-setup-${stamp}`;
const requiredServerSlug = `required-mcp-${stamp}`;
const automaticServerSlug = `automatic-mcp-${stamp}`;
let userId = "";
let workspaceId = "";
let requiredServerId = "";
let automaticServerId = "";

function deploymentForm(serverId: string): FormData {
  const form = new FormData();
  form.set("workspace", workspaceSlug);
  form.set("serverId", serverId);
  return form;
}

function cloneForm(deploymentId: string): FormData {
  const form = new FormData();
  form.set("workspace", workspaceSlug);
  form.set("deploymentId", deploymentId);
  form.set("name", "Detached required MCP");
  form.set("copyEnvironmentVariables", "false");
  return form;
}

describe("catalog MCP deployment setup", () => {
  beforeAll(async () => {
    const user = await db.user.create({ data: { email, passwordHash: "x" } });
    userId = user.id;
    const workspace = await db.workspace.create({
      data: {
        slug: workspaceSlug,
        name: "Deployment setup integration",
        ownerId: user.id,
        members: { create: { userId: user.id, role: "owner" } },
      },
    });
    workspaceId = workspace.id;
    const [requiredServer, automaticServer] = await Promise.all([
      db.server.create({
        data: {
          slug: requiredServerSlug,
          name: "Required MCP",
          verifiedAt: new Date(),
          installCfg: {
            source: "npm",
            ref: "required-mcp",
            env: ["API_TOKEN"],
          },
        },
      }),
      db.server.create({
        data: {
          slug: automaticServerSlug,
          name: "Automatic MCP",
          verifiedAt: new Date(),
          installCfg: {
            source: "npm",
            ref: "@modelcontextprotocol/server-memory",
            env: [],
          },
        },
      }),
    ]);
    requiredServerId = requiredServer.id;
    automaticServerId = automaticServer.id;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: userId, email });
    mocks.liveStatus.mockReturnValue(null);
    mocks.startProcess.mockResolvedValue(undefined);
    // Registry lookups are the only network a first install may perform.
    mocks.fetch.mockImplementation(async (url: string) =>
      url.startsWith("https://registry.npmjs.org/")
        ? new Response(JSON.stringify({ "dist-tags": { latest: "1.2.3" } }))
        : new Response("", { status: 404 }),
    );
    vi.stubGlobal("fetch", mocks.fetch);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await db.workspace.deleteMany({ where: { id: workspaceId } });
    await db.server.deleteMany({
      where: { id: { in: [requiredServerId, automaticServerId] } },
    });
    await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect();
  });

  it("persists setup_required and does not spawn when a required value is empty", async () => {
    await deployServerAction(deploymentForm(requiredServerId));

    const deployment = await db.deployment.findUniqueOrThrow({
      where: {
        workspaceId_serverId: { workspaceId, serverId: requiredServerId },
      },
    });
    expect(deployment.status).toBe("setup_required");
    expect(deployment.sourceRef).toBe("required-mcp@1.2.3");
    expect(deployment.installCfg).toMatchObject({ env: { API_TOKEN: "" } });
    expect(deployment.installCfg).toHaveProperty("credentialEnvelope");
    expect(resolveMcpEnvironment(deployment.installCfg, workspaceId)).toEqual({
      API_TOKEN: "",
    });
    expect(mocks.startProcess).not.toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledWith(
      `/app/${workspaceSlug}/mcp/${deployment.id}?tab=variables`,
    );
  });

  it("keeps one-click startup for a recipe with no missing requirements", async () => {
    await deployServerAction(deploymentForm(automaticServerId));

    const deployment = await db.deployment.findUniqueOrThrow({
      where: {
        workspaceId_serverId: { workspaceId, serverId: automaticServerId },
      },
    });
    expect(deployment.status).toBe("provisioning");
    expect(deployment.sourceRef).toBe(
      "@modelcontextprotocol/server-memory@1.2.3",
    );
    expect(mocks.startProcess).toHaveBeenCalledWith(
      deployment.id,
      expect.any(Object),
      expect.objectContaining({
        awaitReady: false,
        workspaceId,
        onReady: expect.any(Function),
      }),
    );
    expect(mocks.redirect).toHaveBeenCalledWith(
      `/app/${workspaceSlug}/mcp/${deployment.id}`,
    );
  });

  it("keeps required-env constraints when a catalog deployment is cloned without values", async () => {
    await deployServerAction(deploymentForm(requiredServerId));
    const source = await db.deployment.findUniqueOrThrow({
      where: {
        workspaceId_serverId: { workspaceId, serverId: requiredServerId },
      },
    });
    mocks.startProcess.mockClear();
    mocks.redirect.mockClear();

    await cloneDeploymentAction(cloneForm(source.id));

    const clone = await db.deployment.findFirstOrThrow({
      where: { workspaceId, serverId: null, name: "Detached required MCP" },
    });
    expect(clone.status).toBe("setup_required");
    expect(clone.sourceRef).toBe("required-mcp@1.2.3");
    expect(clone.installCfg).toMatchObject({
      env: { API_TOKEN: "" },
      requiredEnv: ["API_TOKEN"],
    });
    expect(resolveMcpEnvironment(clone.installCfg, workspaceId)).toEqual({
      API_TOKEN: "",
    });
    expect(clone.installCfg).not.toHaveProperty("credentialEnvelope");
    expect(mocks.startProcess).not.toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledWith(
      `/app/${workspaceSlug}/mcp/${clone.id}?tab=variables`,
    );
  });
  it("does not create a catalog deployment when its version cannot be pinned", async () => {
    const server = await db.server.create({
      data: {
        slug: `unpinnable-mcp-${stamp}`,
        name: "Unpinnable MCP",
        verifiedAt: new Date(),
        installCfg: { source: "npm", ref: "unpinnable-mcp", env: [] },
      },
    });
    try {
      mocks.fetch.mockResolvedValue(new Response("", { status: 503 }));
      mocks.redirect.mockImplementationOnce((url: string) => {
        throw new Error(`redirect:${url}`);
      });
      await expect(
        deployServerAction(deploymentForm(server.id)),
      ).rejects.toThrow(
        `redirect:/app/${workspaceSlug}/mcp?error=mcpVersionResolutionFailed`,
      );
      expect(
        await db.deployment.count({
          where: { workspaceId, serverId: server.id },
        }),
      ).toBe(0);
      expect(mocks.startProcess).not.toHaveBeenCalled();
    } finally {
      await db.server.deleteMany({ where: { id: server.id } });
    }
  });
  it("stops a running encrypted connection before persisting a rotation and revocation", async () => {
    const deployment = await db.deployment.create({
      data: {
        workspaceId,
        source: "npm",
        sourceRef: "optional-mcp",
        status: "running",
        installCfg: sealMcpEnvironment({}, workspaceId, {
          TOKEN: "initial-secret",
          KEEP: "retained-secret",
        }) as Prisma.InputJsonObject,
      },
    });
    for (const [oldValue, newValue] of [
      ["initial-secret", "rotated-secret"],
      ["rotated-secret", ""],
    ]) {
      mocks.stopProcess.mockImplementationOnce(async (id: string) => {
        expect(id).toBe(deployment.id);
        const before = await db.deployment.findUniqueOrThrow({ where: { id } });
        expect(
          resolveMcpEnvironment(before.installCfg, workspaceId).TOKEN,
        ).toBe(oldValue);
      });
      const form = new FormData();
      form.set("workspace", workspaceSlug);
      form.set("deploymentId", deployment.id);
      form.set(
        "changes",
        JSON.stringify({ set: { TOKEN: newValue }, remove: [] }),
      );
      expect(await setDeploymentEnvAction(form)).toMatchObject({
        savedAt: expect.any(Number),
        requiresSetup: false,
      });
      const stored = await db.deployment.findUniqueOrThrow({
        where: { id: deployment.id },
      });
      expect(stored.status).toBe("stopped");
      expect(resolveMcpEnvironment(stored.installCfg, workspaceId)).toEqual({
        TOKEN: newValue,
        KEEP: "retained-secret",
      });
      expect(stored.installCfg).toMatchObject({ env: { TOKEN: "", KEEP: "" } });
      expect(JSON.stringify(stored.installCfg)).not.toContain(
        "retained-secret",
      );
      if (newValue)
        expect(JSON.stringify(stored.installCfg)).not.toContain(newValue);
    }
    expect(mocks.stopProcess).toHaveBeenCalledTimes(2);
    expect(mocks.startProcess).not.toHaveBeenCalled();
  });
  it("reveals one stored variable only inside the owning workspace", async () => {
    const deployment = await db.deployment.create({
      data: {
        workspaceId,
        source: "npm",
        sourceRef: "reveal-mcp",
        status: "stopped",
        installCfg: sealMcpEnvironment({}, workspaceId, {
          TOKEN: "visible-secret",
        }) as Prisma.InputJsonObject,
      },
    });
    const reveal = (workspace: string, key = "TOKEN") =>
      revealDeploymentEnvAction({
        workspace,
        deploymentId: deployment.id,
        key,
      });
    expect(await reveal(workspaceSlug)).toEqual({ value: "visible-secret" });
    expect(await reveal(workspaceSlug, "MISSING")).toEqual({
      error: "variableNotFound",
    });

    const outsider = await db.user.create({
      data: { email: `outsider-${email}`, passwordHash: "x" },
    });
    const outsiderSlug = `outsider-${workspaceSlug}`;
    try {
      await db.workspace.create({
        data: {
          slug: outsiderSlug,
          name: "Outsider workspace",
          ownerId: outsider.id,
          members: { create: { userId: outsider.id, role: "owner" } },
        },
      });
      mocks.getCurrentUser.mockResolvedValue({
        id: outsider.id,
        email: outsider.email,
      });
      expect(await reveal(workspaceSlug)).toEqual({ error: "notAuthorized" });
      expect(await reveal(outsiderSlug)).toEqual({
        error: "deploymentNotFound",
      });
    } finally {
      await db.workspace.deleteMany({ where: { slug: outsiderSlug } });
      await db.user.deleteMany({ where: { id: outsider.id } });
    }
  });
});
