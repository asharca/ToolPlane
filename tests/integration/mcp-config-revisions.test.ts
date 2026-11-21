// @vitest-environment node
import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
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
import { createMcpFromIntakeAction } from "@/lib/workspace/mcp-intake-actions";
import {
  getMcpConfigAction,
  previewMcpConfigAction,
  rollbackMcpConfigAction,
  saveMcpConfigAction,
  setMcpRuntimeTargetAction,
  setMcpSamplingAction,
  setMcpVariablesAction,
  updateMcpDependenciesAction,
} from "@/lib/workspace/mcp-config-actions";

const effects = vi.hoisted(() => ({ user: vi.fn(), restart: vi.fn() }));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: effects.user }));
vi.mock("@/lib/process/supervisor", () => ({
  stopProcess: vi.fn(),
  startProcess: vi.fn(),
  restartProcess: effects.restart,
  killProcess: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const slug = `mcp-revisions-${randomUUID()}`;
const foreignSlug = `foreign-${slug}`;
let owner: string, member: string, workspaceId: string;
const target = (deploymentId: string) => ({ workspace: slug, deploymentId });
const revisions = (deploymentId: string) =>
  db.mcpConfigRevision.findMany({
    where: { deploymentId },
    orderBy: { revision: "asc" },
  });
const load = (id: string) => db.deployment.findUniqueOrThrow({ where: { id } });
async function legacyRemote() {
  return db.deployment.create({
    data: {
      workspaceId,
      source: "remote",
      sourceRef: "https://example.org/mcp",
      status: "stopped",
      installCfg: { transport: "sse", env: {} },
    },
  });
}

describe("workspace MCP configuration revisions", () => {
  beforeAll(async () => {
    [owner, member] = await Promise.all(
      ["owner", "member"].map(
        async (key) =>
          (
            await db.user.create({
              data: { email: `${key}-${slug}@example.test`, passwordHash: "x" },
            })
          ).id,
      ),
    );
    workspaceId = (
      await db.workspace.create({
        data: {
          slug,
          name: "MCP revisions",
          ownerId: owner,
          members: { create: { userId: member, role: "member" } },
        },
      })
    ).id;
    await db.workspace.create({
      data: { slug: foreignSlug, name: "Separate workspace", ownerId: member },
    });
  });
  beforeEach(() => {
    vi.clearAllMocks();
    effects.user.mockResolvedValue({ id: owner });
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await db.workspace.deleteMany({
      where: { slug: { in: [slug, foreignSlug] } },
    });
    await db.user.deleteMany({ where: { id: { in: [owner, member] } } });
    await db.$disconnect();
  });

  it("creates one immutable entry per deployment, previews without writing, saves derived config and rolls back a lock without exposing secrets", async () => {
    const source = {
      kind: "text" as const,
      text: `{"mcpServers": {"local": { // operator comment\n"command":"node", "args":["server.mjs"],"env":{"API_KEY":"pasted-local-secret"}, "cwd":"/workspace","autoApprove":[]},"other":{"command":"python3","env":{"MISSING":""}}}}`,
    };
    const result = await createMcpFromIntakeAction({
      workspace: slug,
      source,
      items: [
        { id: "0", name: "local", values: {} },
        { id: "1", name: "other", values: {} },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const [local, other] = result.deployments;
    const [original] = await revisions(local.id);
    expect(original).toMatchObject({
      revision: 1,
      format: "mcp-json",
      createdById: owner,
    });
    expect(original.document).toContain("// operator comment");
    expect(original.document).toContain(`\${API_KEY}`);
    expect(original.document).not.toContain("python3");
    expect((await revisions(other.id))[0].document).not.toContain(
      "autoApprove",
    );
    const doc = `{ "args":["server-v2.mjs","--api-key=save-argv-secret"], "command":"node", "cwd":"/workspace/v2", "env":{"OTHER_TOKEN":"new-env-secret","LOG_LEVEL":"debug"} }`;
    const input = { ...target(local.id), document: doc };
    const preview = await previewMcpConfigAction(input);
    expect(preview).toMatchObject({
      ok: true,
      extractedSecrets: ["OTHER_TOKEN", "MCP_ARG_2"],
      restartRequired: true,
    });
    expect(await revisions(local.id)).toHaveLength(1);
    const saved = await saveMcpConfigAction(input);
    expect(saved).toMatchObject({
      ok: true,
      revision: 2,
      status: "provisioning",
    });
    const stored = await load(local.id);
    const history = await revisions(local.id);
    expect(stored.activeRevisionId).toBe(history[1].id);
    expect(history[1].document).toContain('"LOG_LEVEL":"debug"');
    expect(stored.installCfg).toMatchObject({
      command: "node",
      args: ["server-v2.mjs", `--api-key=\${MCP_ARG_2}`],
      cwd: "/workspace/v2",
      env: { OTHER_TOKEN: "", LOG_LEVEL: "", MCP_ARG_2: "" },
    });
    expect(resolveMcpEnvironment(stored.installCfg, workspaceId)).toMatchObject(
      {
        OTHER_TOKEN: "new-env-secret",
        LOG_LEVEL: "debug",
        MCP_ARG_2: "save-argv-secret",
      },
    );
    expect(effects.restart).toHaveBeenCalled();
    const rolled = await rollbackMcpConfigAction({
      ...target(local.id),
      revisionId: original.id,
    });
    expect(rolled).toMatchObject({ ok: true, revision: 3 });
    expect((await load(local.id)).installCfg).toMatchObject({
      args: ["server.mjs"],
      cwd: "/workspace",
    });
    const view = await getMcpConfigAction(target(local.id));
    expect(view).toMatchObject({
      ok: true,
      view: {
        document: original.document,
        ignoredFields: ["autoApprove"],
        revisions: [
          { revision: 3, active: true },
          { revision: 2, active: false },
          { revision: 1, active: false },
        ],
      },
    });
    const publicData = JSON.stringify([
      history,
      stored.installCfg,
      preview,
      saved,
      rolled,
      view,
      result,
    ]);
    for (const literal of [
      "pasted-local-secret",
      "save-argv-secret",
      "new-env-secret",
    ])
      expect(publicData).not.toContain(literal);
    expect(
      await saveMcpConfigAction({
        ...input,
        document: '{"url":"https://example.org"}',
      }),
    ).toMatchObject({ ok: false, error: "kindChangeNotAllowed" });
    expect(
      await rollbackMcpConfigAction({
        ...target(local.id),
        revisionId: (await revisions(other.id))[0].id,
      }),
    ).toMatchObject({ ok: false, error: "notFound" });
    await expect(
      db.mcpConfigRevision.update({
        where: { id: original.id },
        data: { document: "overwritten" },
      }),
    ).rejects.toThrow();
    await expect(
      db.deployment.update({
        where: { id: other.id },
        data: { activeRevisionId: original.id },
      }),
    ).rejects.toThrow();
  });

  it("previews legacy config without backfill and creates exactly one revision on simultaneous first reads or first save", async () => {
    const a = await legacyRemote();
    const input = target(a.id);
    const document =
      '{"url":"https://example.org/new","headers":{"X-Key":"remote-literal-secret"}}';
    expect(await previewMcpConfigAction({ ...input, document })).toMatchObject({
      ok: true,
    });
    expect(await revisions(a.id)).toHaveLength(0);
    await Promise.all([getMcpConfigAction(input), getMcpConfigAction(input)]);
    const [first] = await revisions(a.id);
    expect(await revisions(a.id)).toHaveLength(1);
    expect(first.format).toBe("migrated");
    expect((await load(a.id)).activeRevisionId).toBe(first.id);
    const b = await legacyRemote();
    expect(
      await saveMcpConfigAction({ ...target(b.id), document }),
    ).toMatchObject({ ok: true, revision: 2 });
    expect((await revisions(b.id)).map((r) => r.format)).toEqual([
      "migrated",
      "mcp-json",
    ]);
    expect(
      await setMcpVariablesAction({
        ...target(b.id),
        values: {},
        remove: ["MCP_X_KEY"],
      }),
    ).toMatchObject({ ok: true, revision: 3, status: "setup_required" });
    expect(
      await setMcpRuntimeTargetAction({
        ...target(b.id),
        target: "workspace_sandbox",
        sandboxId: "not-a-sandbox",
      }),
    ).toMatchObject({ ok: false, error: "sandboxUnavailable" });
    expect(
      await setMcpSamplingAction({ ...target(b.id), enabled: true }),
    ).toEqual({ ok: true });
    expect((await load(b.id)).samplingEnabled).toBe(true);
  });

  it("requires management for mutations/arbitrary commands, and includes workspace scope on reads, saves, and rollback", async () => {
    const dep = await legacyRemote();
    const input = target(dep.id);
    const view = await getMcpConfigAction(input);
    if (!view.ok) throw new Error(view.error);
    effects.user.mockResolvedValue({ id: member });
    expect(await getMcpConfigAction(input)).toMatchObject({
      ok: true,
      view: { canManage: false },
    });
    const foreign = { workspace: foreignSlug, deploymentId: dep.id };
    for (const [request, error] of [
      [input, "notAuthorized"],
      [foreign, "notFound"],
    ] as const) {
      const denied = await Promise.all([
        saveMcpConfigAction({ ...request, document: view.view.document }),
        rollbackMcpConfigAction({
          ...request,
          revisionId: view.view.activeRevisionId,
        }),
        setMcpVariablesAction({
          ...request,
          values: { TOKEN: "unauthorized" },
        }),
        setMcpSamplingAction({ ...request, enabled: true }),
        setMcpRuntimeTargetAction({ ...request, target: "managed" }),
        updateMcpDependenciesAction(request),
      ]);
      for (const outcome of denied)
        expect(outcome).toEqual({ ok: false, error });
    }
    expect(await getMcpConfigAction(foreign)).toEqual({
      ok: false,
      error: "notFound",
    });
    expect(
      await createMcpFromIntakeAction({
        workspace: slug,
        source: { kind: "text", text: "node server.mjs" },
        items: [{ id: "0", name: "denied", values: {} }],
      }),
    ).toEqual({ ok: false, error: "arbitraryCommandNotAllowed" });
    expect(await revisions(dep.id)).toHaveLength(1);
    expect((await load(dep.id)).samplingEnabled).toBe(false);
  });

  it("updates dependency pins without rewriting the user's selector and restores the historical lock on rollback", async () => {
    let version = "1.0.0";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url !== "https://registry.npmjs.org/revision-test")
          throw new Error("unexpected registry");
        return Response.json({ "dist-tags": { latest: version } });
      }),
    );
    try {
      const created = await createMcpFromIntakeAction({
        workspace: slug,
        source: { kind: "text", text: "npx -y revision-test@latest" },
        items: [{ id: "0", name: "Pinned", values: {} }],
      });
      if (!created.ok) throw new Error(created.error);
      const input = target(created.deployments[0].id);
      const [original] = await revisions(input.deploymentId);
      expect(original.document).toContain("revision-test@latest");
      expect(original.format).toBe("command");
      version = "2.0.0";
      expect(await updateMcpDependenciesAction(input)).toMatchObject({
        ok: true,
        revision: 2,
      });
      const [, updated] = await revisions(input.deploymentId);
      expect(updated.document).toBe(original.document);
      expect(updated.resolved).toMatchObject({
        args: ["-y", "revision-test@2.0.0"],
      });
      expect(
        await rollbackMcpConfigAction({ ...input, revisionId: original.id }),
      ).toMatchObject({ ok: true, revision: 3 });
      expect((await load(input.deploymentId)).installCfg).toMatchObject({
        args: ["-y", "revision-test@1.0.0"],
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("clears the previous OAuth grant when switching resource URL", async () => {
    const resource = "https://example.org/old";
    const dep = await db.deployment.create({
      data: {
        workspaceId,
        source: "remote",
        sourceRef: resource,
        installCfg: sealMcpEnvironment(
          { transport: "streamable-http", authType: "oauth", resource },
          workspaceId,
          {},
        ) as Prisma.InputJsonObject,
      },
    });
    await db.mcpOAuthCredential.create({
      data: {
        workspaceId,
        deploymentId: dep.id,
        issuer: "https://example.org",
        clientId: "client",
        resource,
        encryptedAccessToken: {},
        scopes: [],
      },
    });
    expect(
      await saveMcpConfigAction({
        ...target(dep.id),
        document: '{"url":"https://example.org/new"}',
      }),
    ).toMatchObject({ ok: true, status: "setup_required" });
    expect(
      await db.mcpOAuthCredential.count({ where: { deploymentId: dep.id } }),
    ).toBe(0);
    expect((await load(dep.id)).installCfg).toMatchObject({
      authType: "oauth",
      resource: "https://example.org/new",
      issuer: null,
    });
  });
});
