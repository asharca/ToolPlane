// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as SshTargets from "@/lib/sandboxes/ssh-targets";
const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  workspace: vi.fn(),
  begin: vi.fn(),
  release: vi.fn(),
  targets: vi.fn(),
  resolveTarget: vi.fn(),
  start: vi.fn(),
  createDeployment: vi.fn(),
  createSandbox: vi.fn(),
  update: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    workspace: { findFirst: mocks.workspace },
    deployment: { updateMany: mocks.update },
    $transaction: async (operation: (tx: unknown) => Promise<unknown>) =>
      operation({
        deployment: { create: mocks.createDeployment },
        sandbox: { create: mocks.createSandbox },
      }),
  },
}));
vi.mock("@/lib/sandboxes/mcp-management", () => ({
  sandboxManagementUser: mocks.user,
}));
vi.mock("@/lib/process/supervisor", () => ({ startProcess: mocks.start }));
vi.mock("@/lib/workspace/operation-gate", () => ({
  beginWorkspaceOperation: mocks.begin,
}));
vi.mock("@/lib/sandboxes/ssh-targets", async (importOriginal) => ({
  ...(await importOriginal<typeof SshTargets>()),
  listSshTargetsForWorkspace: mocks.targets,
  resolveSshTargetForWorkspace: mocks.resolveTarget,
}));
import { handleSshSandboxes } from "@/lib/sandboxes/ssh-management";

function request(
  method = "POST",
  body: unknown = {
    name: " My SSH ",
    targetId: "approved",
    acknowledgeHostAccess: true,
  },
) {
  return new Request("https://app.test/api/ssh", {
    method,
    ...(method === "GET"
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue({ id: "user-1" });
  mocks.workspace.mockResolvedValue({
    id: "workspace-1",
    slug: "my-workspace",
  });
  mocks.begin.mockReturnValue(mocks.release);
  mocks.targets.mockReturnValue([{ id: "approved", name: "Approved host" }]);
  mocks.createDeployment.mockImplementation(async ({ data }) => ({ ...data }));
  mocks.start.mockResolvedValue(undefined);
  mocks.createSandbox.mockResolvedValue({});
  mocks.update.mockResolvedValue({ count: 1 });
});
afterEach(() => vi.restoreAllMocks());

describe("SSH sandbox management", () => {
  it("requires an account session or personal credential before workspace lookup", async () => {
    mocks.user.mockResolvedValue(null);
    const response = await handleSshSandboxes(request("GET"), "workspace-1");
    expect(response.status).toBe(401);
    expect(mocks.workspace).not.toHaveBeenCalled();
  });
  it("hides inaccessible workspaces and rejects draining workspaces", async () => {
    mocks.workspace.mockResolvedValueOnce(null);
    expect(
      (await handleSshSandboxes(request("GET"), "workspace-1")).status,
    ).toBe(404);
    mocks.begin.mockReturnValueOnce(null);
    expect(
      (await handleSshSandboxes(request("GET"), "workspace-1")).status,
    ).toBe(409);
    expect(mocks.targets).not.toHaveBeenCalled();
  });
  it("lists authorized target labels with private response caching", async () => {
    const response = await handleSshSandboxes(request("GET"), "workspace-1");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      targets: [{ id: "approved", name: "Approved host" }],
    });
    expect(mocks.targets).toHaveBeenCalledWith("workspace-1");
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it.each([
    { name: "host", targetId: "approved" },
    { name: "host", targetId: "approved", acknowledgeHostAccess: false },
    {
      name: "host",
      targetId: "approved",
      acknowledgeHostAccess: true,
      host: "evil.test",
    },
    { name: " ", targetId: "approved", acknowledgeHostAccess: true },
    { name: "host", targetId: "../escape", acknowledgeHostAccess: true },
  ])("rejects unsafe or unacknowledged host access", async (body) => {
    const response = await handleSshSandboxes(
      request("POST", body),
      "workspace-1",
    );
    expect(response.status).toBe(400);
    expect(mocks.createDeployment).not.toHaveBeenCalled();
    expect(mocks.resolveTarget).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it("releases the operation gate on unsupported methods and malformed bodies", async () => {
    expect(
      (await handleSshSandboxes(request("DELETE"), "workspace-1")).status,
    ).toBe(405);
    const response = await handleSshSandboxes(
      new Request("https://app.test/ssh", {
        method: "POST",
        body: "not json",
        headers: { "content-type": "application/json" },
      }),
      "workspace-1",
    );
    expect(response.status).toBe(400);
    expect(mocks.release).toHaveBeenCalledTimes(2);
  });
  it("does not expose private target configuration failures", async () => {
    mocks.resolveTarget.mockImplementation(() => {
      throw new Error("private host and key path");
    });
    const response = await handleSshSandboxes(request(), "workspace-1");
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain("private host and key path");
    expect(mocks.createDeployment).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it.each([false, true])(
    "creates scoped SSH records and reports startup failure=%s without creating duplicates",
    async (failed) => {
      if (failed) mocks.start.mockRejectedValue(new Error("SSH denied"));
      const response = await handleSshSandboxes(request(), "workspace-1");
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.status).toBe(failed ? "error" : "provisioning");
      expect(mocks.resolveTarget).toHaveBeenCalledWith(
        "approved",
        "workspace-1",
      );
      expect(mocks.createSandbox).toHaveBeenCalledWith({
        data: {
          id: body.id,
          deploymentId: body.deploymentId,
          workspaceId: "workspace-1",
          name: "My SSH",
          slug: `ssh-${body.id}`,
          kind: "ssh",
          image: null,
          network: "isolated",
          config: { sshTargetId: "approved", env: {} },
        },
      });
      expect(mocks.start).toHaveBeenCalledWith(
        body.deploymentId,
        {
          kind: "sandbox",
          name: "Sandbox: My SSH",
          sandboxId: body.id,
          sandboxKind: "ssh",
          sshTargetId: "approved",
          network: "isolated",
          env: {},
        },
        { awaitReady: false, workspaceId: "workspace-1" },
      );
      if (failed) {
        expect(body.error).toContain("do not create a duplicate");
        expect(mocks.update).toHaveBeenCalledWith({
          where: { id: body.deploymentId, workspaceId: "workspace-1" },
          data: { status: "error" },
        });
      } else {
        expect(body.consolePath).toBe(`/app/my-workspace/sandboxes/${body.id}`);
        expect(body.mcpEndpoint).toBe(`/api/v1/sandboxes/${body.id}/mcp`);
        expect(mocks.update).not.toHaveBeenCalled();
      }
      expect(mocks.release).toHaveBeenCalledOnce();
    },
  );
});
