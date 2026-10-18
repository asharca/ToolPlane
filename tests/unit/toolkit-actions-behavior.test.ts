// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  workspace: vi.fn(),
  member: vi.fn(),
  find: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  market: vi.fn(),
  modified: vi.fn(),
  revoke: vi.fn(),
  servers: vi.fn(),
  skills: vi.fn(),
  addServers: vi.fn(),
  addSkills: vi.fn(),
  removeServers: vi.fn(),
  removeSkills: vi.fn(),
  cloneDeployment: vi.fn(),
  cloneSkill: vi.fn(),
  createSkill: vi.fn(),
  linkServer: vi.fn(),
  linkSkill: vi.fn(),
  transaction: vi.fn(),
  revalidate: vi.fn(),
  redirect: vi.fn(),
}));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/workspace/queries", () => ({
  getWorkspaceForUser: mocks.workspace,
}));
vi.mock("@/lib/toolkits/install-link", () => ({
  revokeToolkitInstallTokens: mocks.revoke,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/db", () => ({
  db: {
    membership: { findUnique: mocks.member },
    toolkit: {
      findFirst: mocks.find,
      create: mocks.create,
      update: mocks.update,
      delete: mocks.remove,
    },
    marketInstall: { findUnique: mocks.market, updateMany: mocks.modified },
    $transaction: mocks.transaction,
  },
}));
import {
  addServersToToolkitAction,
  addSkillsToToolkitAction,
  clonePublicToolkitAction,
  cloneToolkitAction,
  createToolkitAction,
  deleteToolkitAction,
  removeServerFromToolkitAction,
  removeSkillFromToolkitAction,
  renameToolkitAction,
  updateToolkitAvailabilityAction,
} from "@/lib/toolkits/actions";
import { MAX_TOOLKIT_BATCH_ITEMS } from "@/lib/toolkits/limits";
function form(
  values: Record<string, string | undefined> = {},
  ids: string[] = [],
) {
  const data = new FormData();
  for (const [key, value] of Object.entries({
    workspace: "team",
    toolkitSlug: "tools",
    ...values,
  }))
    if (value !== undefined) data.set(key, value);
  for (const id of ids) data.append("resourceId", id);
  return data;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue({ id: "user" });
  mocks.workspace.mockResolvedValue({ id: "workspace", ownerId: "user" });
  mocks.find.mockResolvedValue({ id: "toolkit" });
  mocks.create.mockResolvedValue({ id: "new", slug: "new" });
  mocks.servers.mockResolvedValue([{ id: "resource" }]);
  mocks.skills.mockResolvedValue([{ id: "resource" }]);
  mocks.addServers.mockResolvedValue({ count: 1 });
  mocks.addSkills.mockResolvedValue({ count: 1 });
  mocks.removeServers.mockResolvedValue({ count: 1 });
  mocks.removeSkills.mockResolvedValue({ count: 1 });
  mocks.cloneDeployment.mockResolvedValue({ id: "cloned-deployment" });
  mocks.cloneSkill.mockResolvedValue({ id: "cloned-skill" });
  mocks.createSkill.mockResolvedValue({ id: "custom-skill" });
  mocks.redirect.mockImplementation((url) => {
    throw new Error(`REDIRECT:${url}`);
  });
  mocks.transaction.mockImplementation(async (operation) =>
    typeof operation === "function"
      ? operation({
          toolkit: { findFirst: mocks.find, create: mocks.create },
          deployment: {
            findMany: mocks.servers,
            upsert: mocks.cloneDeployment,
          },
          installedSkill: {
            findMany: mocks.skills,
            upsert: mocks.cloneSkill,
            create: mocks.createSkill,
          },
          toolkitServer: {
            createMany: mocks.addServers,
            deleteMany: mocks.removeServers,
            upsert: mocks.linkServer,
          },
          toolkitSkill: {
            createMany: mocks.addSkills,
            deleteMany: mocks.removeSkills,
            upsert: mocks.linkSkill,
          },
          marketInstall: { updateMany: mocks.modified },
        })
      : Promise.all(operation),
  );
});

describe("public toolkit clone data isolation", () => {
  it("copies only verified recipes and recreates custom skills without copying workspace secrets", async () => {
    mocks.find
      .mockResolvedValueOnce({
        workspaceId: "foreign",
        name: "Public",
        servers: [
          { deployment: { serverId: null } },
          {
            deployment: {
              serverId: "unverified",
              server: { verifiedAt: null },
            },
          },
          {
            deployment: {
              serverId: "invalid",
              server: { verifiedAt: new Date(), installCfg: {} },
            },
          },
          {
            deployment: {
              serverId: "needs-setup",
              server: {
                verifiedAt: new Date(),
                installCfg: {
                  source: "npm",
                  ref: "example-package",
                  env: ["API_KEY"],
                },
              },
              installCfg: { env: { API_KEY: "never-copy-this-secret" } },
            },
          },
          {
            deployment: {
              serverId: "ready",
              server: {
                verifiedAt: new Date(),
                installCfg: { source: "npm", ref: "example-package", env: [] },
              },
            },
          },
        ],
        skills: [
          { installedSkill: { skillId: "catalog-skill" } },
          {
            installedSkill: {
              skillId: null,
              name: "Custom",
              slug: "custom",
              content: "# Custom",
              source: "custom",
              files: null,
            },
          },
          {
            installedSkill: {
              skillId: null,
              name: "Assets",
              slug: "assets",
              content: "# Assets",
              source: "upload",
              files: [{ path: "data.txt", content: "data" }],
            },
          },
        ],
      })
      .mockResolvedValue(null);
    await expect(
      clonePublicToolkitAction(form({ toolkitId: "source" })),
    ).rejects.toThrow("REDIRECT:/app/team/toolkits/new");
    expect(mocks.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "workspace",
        name: "Public",
        slug: "public",
        visibility: "private",
        enabled: true,
      },
    });
    expect(mocks.cloneDeployment).toHaveBeenCalledTimes(2);
    expect(mocks.cloneDeployment.mock.calls[0][0].create).toMatchObject({
      status: "setup_required",
      serverId: "needs-setup",
      workspaceId: "workspace",
    });
    expect(mocks.cloneDeployment.mock.calls[1][0].create).toMatchObject({
      status: "stopped",
      serverId: "ready",
    });
    expect(JSON.stringify(mocks.cloneDeployment.mock.calls)).not.toContain(
      "never-copy-this-secret",
    );
    expect(mocks.linkServer).toHaveBeenCalledTimes(2);
    expect(mocks.cloneSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { workspaceId: "workspace", skillId: "catalog-skill" },
      }),
    );
    expect(mocks.createSkill.mock.calls[0][0].data).not.toHaveProperty("files");
    expect(mocks.createSkill.mock.calls[1][0].data.files).toEqual([
      { path: "data.txt", content: "data" },
    ]);
    expect(mocks.linkSkill).toHaveBeenCalledTimes(3);
  });
  it("does not clone missing owned toolkits and bounds clone race retries", async () => {
    mocks.find.mockResolvedValueOnce(null);
    await cloneToolkitAction(form());
    expect(mocks.create).not.toHaveBeenCalled();
    mocks.find
      .mockResolvedValueOnce({ name: "Source", servers: [], skills: [] })
      .mockResolvedValue(null);
    const conflict = { code: "P2002" };
    mocks.create.mockRejectedValue(conflict);
    await expect(cloneToolkitAction(form({ name: "Me" }))).rejects.toBe(
      conflict,
    );
    expect(mocks.create).toHaveBeenCalledTimes(10);
    expect(mocks.create.mock.calls[0][0].data).toMatchObject({
      name: "Me 2",
      slug: "me-2",
    });
  });
});

describe("toolkit batch resource ownership", () => {
  it.each([addServersToToolkitAction, addSkillsToToolkitAction])(
    "rejects malformed selections before authorization",
    async (action) => {
      for (const [ids, expected] of [
        [[], "Select at least one item."],
        [
          Array(MAX_TOOLKIT_BATCH_ITEMS + 1).fill("a"),
          `Select no more than ${MAX_TOOLKIT_BATCH_ITEMS} items at once.`,
        ],
        [[" "], "Invalid resource selection."],
        [["a".repeat(129)], "Invalid resource selection."],
      ] as const) {
        expect(await action({}, form({}, [...ids]))).toEqual({
          error: expected,
        });
      }
      const data = form();
      data.append("resourceId", new File(["x"], "resource"));
      expect(await action({}, data)).toEqual({
        error: "Invalid resource selection.",
      });
      expect(mocks.user).not.toHaveBeenCalled();
    },
  );
  it.each([addServersToToolkitAction, addSkillsToToolkitAction])(
    "checks workspace and toolkit before importing resources",
    async (action) => {
      mocks.user.mockResolvedValueOnce(null);
      expect(await action({}, form({}, ["resource"]))).toEqual({
        error: "Workspace not found or access denied.",
      });
      mocks.find.mockResolvedValueOnce(null);
      expect(await action({}, form({}, ["resource"]))).toEqual({
        error: "Toolkit not found.",
      });
      expect(mocks.addSkills).not.toHaveBeenCalled();
      expect(mocks.addServers).not.toHaveBeenCalled();
    },
  );
  it.each(["servers", "skills"] as const)(
    "rejects resources not owned by the workspace: %s",
    async (kind) => {
      mocks[kind].mockResolvedValue([]);
      const action =
        kind === "servers"
          ? addServersToToolkitAction
          : addSkillsToToolkitAction;
      expect(await action({}, form({}, ["resource"]))).toEqual({
        error: `One or more selected ${kind === "servers" ? "MCPs" : "skills"} are unavailable.`,
      });
      expect(mocks.modified).not.toHaveBeenCalled();
    },
  );
  it.each(["servers", "skills"] as const)(
    "deduplicates selected %s and marks only actual additions modified",
    async (kind) => {
      const action =
        kind === "servers"
          ? addServersToToolkitAction
          : addSkillsToToolkitAction;
      const create = kind === "servers" ? mocks.addServers : mocks.addSkills;
      expect(await action({}, form({}, [" resource ", "resource"]))).toEqual({
        added: 1,
      });
      expect(create).toHaveBeenCalledWith({
        data: [
          {
            toolkitId: "toolkit",
            [kind === "servers" ? "deploymentId" : "installedSkillId"]:
              "resource",
          },
        ],
        skipDuplicates: true,
      });
      expect(mocks.modified).toHaveBeenCalledOnce();
      create.mockResolvedValueOnce({ count: 0 });
      expect(await action({}, form({}, ["resource"]))).toEqual({ added: 0 });
      expect(mocks.modified).toHaveBeenCalledOnce();
      expect(mocks.revalidate).toHaveBeenCalledWith("/app/team/toolkits/tools");
      mocks.transaction.mockRejectedValueOnce(
        new Error("private database error"),
      );
      expect(await action({}, form({}, ["resource"]))).toEqual({
        error: "Failed to add selected items.",
      });
    },
  );
});

describe("toolkit publishing and mutation authorization", () => {
  it.each(["user", "workspace"] as const)(
    "does not mutate when %s authorization is absent",
    async (missing) => {
      mocks[missing].mockResolvedValue(null);
      for (const action of [
        createToolkitAction,
        cloneToolkitAction,
        clonePublicToolkitAction,
        renameToolkitAction,
        updateToolkitAvailabilityAction,
        deleteToolkitAction,
        removeServerFromToolkitAction,
        removeSkillFromToolkitAction,
      ])
        await action(
          form({ name: "Name", visibility: "public", toolkitId: "source" }),
        );
      expect(mocks.update).not.toHaveBeenCalled();
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.remove).not.toHaveBeenCalled();
    },
  );
  it.each([null, { role: "member" }, { role: "admin" }])(
    "requires owner or admin to publish: %j",
    async (membership) => {
      mocks.workspace.mockResolvedValue({ id: "workspace", ownerId: "other" });
      mocks.member.mockResolvedValue(membership);
      await updateToolkitAvailabilityAction(
        form({ visibility: "public", enabled: "on" }),
      );
      if (membership?.role === "admin")
        expect(mocks.update).toHaveBeenCalledWith({
          where: { id: "toolkit" },
          data: { visibility: "public", enabled: true },
        });
      else expect(mocks.update).not.toHaveBeenCalled();
    },
  );
  it("allows owner publication without membership lookup and unpublishes disabled toolkits", async () => {
    await updateToolkitAvailabilityAction(form({ visibility: "private" }));
    expect(mocks.member).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "toolkit" },
      data: { visibility: "private", enabled: false },
    });
    mocks.find.mockResolvedValueOnce(null);
    await updateToolkitAvailabilityAction(form({ visibility: "public" }));
    expect(mocks.update).toHaveBeenCalledOnce();
  });
  it.each([{ workspace: "" }, { toolkitSlug: "" }, { visibility: "invalid" }])(
    "rejects malformed availability changes",
    async (values) => {
      await updateToolkitAvailabilityAction(
        form({ visibility: "public", ...values }),
      );
      expect(mocks.user).not.toHaveBeenCalled();
    },
  );
  it.each(["", " ", "a".repeat(61)])(
    "does not rename to invalid name %j",
    async (name) => {
      await renameToolkitAction(form({ name }));
      expect(mocks.update).not.toHaveBeenCalled();
    },
  );
  it("renames only within the authorized workspace and marks market installs modified", async () => {
    await renameToolkitAction(form({ name: "  New Name  " }));
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "toolkit" },
      data: { name: "New Name" },
    });
    expect(mocks.modified).toHaveBeenCalledWith({
      where: { toolkitId: "toolkit" },
      data: { status: "modified" },
    });
    mocks.find.mockResolvedValueOnce(null);
    await renameToolkitAction(form({ name: "Other" }));
    expect(mocks.update).toHaveBeenCalledOnce();
  });
  it("protects default and market-managed toolkits, revoking tokens before deletion", async () => {
    await deleteToolkitAction(form({ toolkitSlug: "me" }));
    expect(mocks.find).not.toHaveBeenCalled();
    mocks.market.mockResolvedValueOnce({ id: "managed" });
    await deleteToolkitAction(form());
    expect(mocks.remove).not.toHaveBeenCalled();
    mocks.find.mockResolvedValueOnce(null);
    await deleteToolkitAction(form());
    await expect(deleteToolkitAction(form())).rejects.toThrow(
      "REDIRECT:/app/team/toolkits",
    );
    expect(mocks.revoke).toHaveBeenCalledWith("toolkit");
    expect(mocks.revoke.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.remove.mock.invocationCallOrder[0],
    );
  });
  it.each([removeServerFromToolkitAction, removeSkillFromToolkitAction])(
    "marks actual resource removals modified without dirtying idempotent removals",
    async (action) => {
      await action(
        form({ deploymentId: "deployment", installedSkillId: "skill" }),
      );
      expect(mocks.modified).toHaveBeenCalledOnce();
      mocks.removeServers.mockResolvedValue({ count: 0 });
      mocks.removeSkills.mockResolvedValue({ count: 0 });
      await action(form());
      expect(mocks.modified).toHaveBeenCalledOnce();
      mocks.find.mockResolvedValueOnce(null);
      await action(form());
      expect(mocks.transaction).toHaveBeenCalledTimes(2);
    },
  );
});

describe("toolkit identity allocation and clones", () => {
  it.each([undefined, "", "a".repeat(61)])(
    "uses a default toolkit name for invalid input %s",
    async (name) => {
      mocks.find.mockResolvedValue(null);
      await expect(
        createToolkitAction(form(name === undefined ? {} : { name })),
      ).rejects.toThrow("REDIRECT:");
      expect(mocks.create).toHaveBeenCalledWith({
        data: {
          workspaceId: "workspace",
          name: "New toolkit",
          slug: "new-toolkit",
        },
        select: { slug: true },
      });
    },
  );
  it("avoids reserved slugs, existing identities, and concurrent unique constraints", async () => {
    mocks.find.mockResolvedValueOnce({ id: "taken" }).mockResolvedValue(null);
    mocks.create
      .mockRejectedValueOnce({ code: "P2002" })
      .mockResolvedValueOnce({ slug: "me-2" });
    await expect(createToolkitAction(form({ name: "Me" }))).rejects.toThrow(
      "REDIRECT:/app/team/toolkits/me-2",
    );
    expect(mocks.create.mock.calls[0][0].data.slug).toBe("me-2");
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });
  it.each([new Error("offline"), null, "failed", { code: "P2003" }])(
    "propagates non-conflict creation errors",
    async (error) => {
      mocks.find.mockResolvedValue(null);
      mocks.create.mockRejectedValue(error);
      await expect(createToolkitAction(form({ name: "工具" }))).rejects.toBe(
        error,
      );
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ slug: "toolkit" }),
        }),
      );
    },
  );
  it("bounds unique-constraint retries", async () => {
    mocks.find.mockResolvedValue(null);
    const conflict = { code: "P2002" };
    mocks.create.mockRejectedValue(conflict);
    await expect(createToolkitAction(form())).rejects.toBe(conflict);
    expect(mocks.create).toHaveBeenCalledTimes(10);
  });
  it.each(["servers", "skills"] as const)(
    "refuses to clone cross-workspace linked %s",
    async (kind) => {
      mocks.find.mockResolvedValue({
        name: "Source",
        servers:
          kind === "servers"
            ? [{ deployment: { workspaceId: "foreign" } }]
            : [],
        skills:
          kind === "skills"
            ? [{ installedSkill: { workspaceId: "foreign" } }]
            : [],
      });
      await cloneToolkitAction(form());
      expect(mocks.create).not.toHaveBeenCalled();
    },
  );
  it("clones owned links privately, allocates a nonconflicting name and retries races", async () => {
    const source = {
      name: "Source",
      servers: [
        {
          deploymentId: "deployment",
          deployment: { workspaceId: "workspace" },
        },
      ],
      skills: [
        {
          installedSkillId: "skill",
          installedSkill: { workspaceId: "workspace" },
        },
      ],
    };
    mocks.find
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce({ id: "existing" })
      .mockResolvedValue(null);
    mocks.create
      .mockRejectedValueOnce({ code: "P2002" })
      .mockResolvedValueOnce({ slug: "source-copy" });
    await expect(cloneToolkitAction(form())).rejects.toThrow(
      "REDIRECT:/app/team/toolkits/source-copy",
    );
    expect(mocks.create.mock.calls[0][0].data).toEqual({
      workspaceId: "workspace",
      name: "Source Copy 2",
      slug: "source-copy-2",
      visibility: "private",
      enabled: true,
      servers: { create: [{ deploymentId: "deployment" }] },
      skills: { create: [{ installedSkillId: "skill" }] },
    });
  });
  it.each(["", "a".repeat(61)])(
    "rejects invalid explicit clone names",
    async (name) => {
      mocks.find.mockResolvedValue({ name: "Source", servers: [], skills: [] });
      await cloneToolkitAction(form({ name }));
      expect(mocks.create).not.toHaveBeenCalled();
    },
  );
  it("redirects a public toolkit already owned without duplicating it", async () => {
    mocks.find.mockResolvedValueOnce({
      workspaceId: "workspace",
      slug: "existing",
    });
    await expect(
      clonePublicToolkitAction(form({ toolkitId: "source" })),
    ).rejects.toThrow("REDIRECT:/app/team/toolkits/existing");
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("does not clone absent public sources or omitted ids", async () => {
    await clonePublicToolkitAction(form());
    expect(mocks.find).not.toHaveBeenCalled();
    mocks.find.mockResolvedValueOnce(null);
    await clonePublicToolkitAction(form({ toolkitId: "missing" }));
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
