// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { createAgent } from "@/lib/agents/mutations";
import {
  setAgentPiPackages,
  updateAgent,
} from "@/lib/agents/agent-draft-mutations";
import {
  createAgentRuntimeToken,
  verifyAgentRuntimeToken,
} from "@/lib/agents/runtime-access";
import { resolvePiSessionPackages } from "@/lib/agents/pi-session-packages";
import { revokeDangerousMarketRelease } from "@/lib/pi-packages/revocation";
import { marketReleaseChecksum } from "@/lib/pi-packages/artifact";
import type * as SandboxRuntimeModule from "@/lib/agents/sandbox-runtime";
import { addPlugin } from "@/lib/plugins/installs";
import { getPlugin, listPluginCards, listPlugins } from "@/lib/plugins/catalog";
import {
  clearOfficialPluginEnvPreset,
  decryptMarketInstallCustomEnvValues,
  saveOfficialPluginEnvPreset,
  updatePluginEnvConfig,
} from "@/lib/plugins/env-store";
import * as runtimeEnvModule from "@/lib/plugins/runtime-env";

const {
  collectSessionCustomNonProxyPluginSecrets,
  collectSessionPluginSecretsForRedaction,
  prepareTurnPluginEnv,
} = runtimeEnvModule;
import { POST as proxyPost } from "@/app/api/v1/agent-runtime/plugins/[installId]/[proxyKey]/[[...path]]/route";
import { logHealth } from "@/lib/observability/events";
import {
  PRIVATE_HOSTS_SETTING_KEY,
  resetPrivateHostsSettings,
  updatePrivateHostsSettings,
} from "@/lib/admin/settings";
import { TRANSPORT_SETTINGS_KEY } from "@/lib/admin/transport-settings";
import { parsePiPackageReleaseManifest } from "@/lib/pi-packages/manifest";
import { testWorkspaceScope } from "../helpers/workspace-scope";
import { publishFixtureAgentRevision } from "./agent-revision-fixture";

vi.mock("@/lib/agents/sandbox-runtime", async (original) => ({
  ...(await original<typeof SandboxRuntimeModule>()),
  preflightPiSdkCapabilities: vi
    .fn()
    .mockResolvedValue({ commands: [], tools: [], skills: [], prompts: [] }),
}));

const testHooks = vi.hoisted(() => ({
  allowLoopbackCustomAddress: false,
}));

vi.mock("@/lib/plugins/runtime-env", async (original) => {
  const mod = await original<typeof import("@/lib/plugins/runtime-env")>();
  return {
    ...mod,
    resolveCustomPluginUpstreamAddress: async (
      host: string,
      signal: AbortSignal,
    ) => {
      if (testHooks.allowLoopbackCustomAddress && host === "127.0.0.1") {
        return { address: "127.0.0.1", family: 4 };
      }
      return mod.resolveCustomPluginUpstreamAddress(host, signal);
    },
  };
});

type RecordedRequest = {
  method: string;
  url: string;
  authorization?: string;
  contentType?: string;
  bodyText: string;
};

let platformServer: Server;
let customServer: Server;
let platformOrigin = "";
let customOrigin = "";
const platformRequests: RecordedRequest[] = [];
const customRequests: RecordedRequest[] = [];
let customMode401 = false;

let prevTransportSetting: string | null = null;
let prevPrivateHostsSetting: string | null = null;

let adminUserId: string;
let memberUserId: string;
let wsAId: string;
let wsBId: string;
let officialRegistryId: string;
let officialListingId: string;
let officialReleaseId: string;
let privateListingId: string;
let privateReleaseId: string;
let nonProxyOfficialListingId: string;

const PLATFORM_SECRET = "plat_ocr_super_secret_987654321";
const CUSTOM_SECRET_A = "cust_ocr_alpha_secret_123456789";
const CUSTOM_SECRET_B = "cust_ocr_bravo_secret_555666777";
const CUSTOM_RAW_SECRET = "raw_non_proxied_custom_secret_222";

function buildPluginManifest(opts: {
  slug: string;
  env: Array<{
    name: string;
    required?: boolean;
    secret?: boolean;
    kind?: "string" | "url";
  }>;
  httpProxies?: Array<{
    key: string;
    baseUrlEnv: string;
    auth: { type: "bearer"; secretEnv: string };
  }>;
}) {
  const indexContent = "export default () => {}";
  return {
    schemaVersion: 1 as const,
    kind: "pi-package" as const,
    listing: {
      slug: opts.slug,
      name: opts.slug,
      summary: `${opts.slug} summary`,
      iconUrl: null,
      tags: [],
      author: "toolplane",
    },
    package: {
      source: {
        kind: "toolplane" as const,
        requested: `toolplane:${opts.slug}@2.1.0`,
        name: opts.slug,
        version: "2.1.0",
      },
      name: opts.slug,
      version: "2.1.0",
      root: "package",
      runtime: {
        kind: "pi-sdk" as const,
        piVersion: "1.5.2" as const,
        nodeMajor: 26 as const,
        platform: "any" as const,
        arch: "any" as const,
      },
      resources: {
        extensions: ["package/index.mjs"],
        skills: [],
        prompts: [],
        themes: [],
      },
      entries: [
        { type: "directory" as const, path: "package" },
        {
          type: "file" as const,
          path: "package/index.mjs",
          contentEncoding: "base64" as const,
          content: Buffer.from(indexContent).toString("base64"),
          executable: false,
          sha256: createHash("sha256").update(indexContent).digest("hex"),
        },
      ],
      toolplane: {
        schemaVersion: 1 as const,
        mcp: [],
        env: opts.env,
        ...(opts.httpProxies ? { httpProxies: opts.httpProxies } : {}),
      },
    },
  };
}

function startMockServer(
  recorder: RecordedRequest[],
  respond: (req: RecordedRequest) => {
    status: number;
    headers?: Record<string, string>;
    body: string;
  },
): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) =>
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
      );
      req.on("end", () => {
        const entry: RecordedRequest = {
          method: req.method ?? "GET",
          url: req.url ?? "/",
          authorization:
            typeof req.headers.authorization === "string"
              ? req.headers.authorization
              : undefined,
          contentType:
            typeof req.headers["content-type"] === "string"
              ? req.headers["content-type"]
              : undefined,
          bodyText: Buffer.concat(chunks).toString("utf8"),
        };
        recorder.push(entry);
        const reply = respond(entry);
        res.writeHead(reply.status, reply.headers);
        res.end(reply.body);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        throw new Error("Expected TCP server address");
      }
      resolve({ server, origin: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function flushLogs() {
  for (let i = 0; i < 40 && logHealth.pending > 0; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  process.env.AUTH_SECRET ||= randomUUID();

  const [transportRow, privateHostsRow] = await Promise.all([
    db.systemSetting.findUnique({ where: { key: TRANSPORT_SETTINGS_KEY } }),
    db.systemSetting.findUnique({ where: { key: PRIVATE_HOSTS_SETTING_KEY } }),
  ]);
  prevTransportSetting = transportRow?.value ?? null;
  prevPrivateHostsSetting = privateHostsRow?.value ?? null;

  await db.systemSetting.upsert({
    where: { key: TRANSPORT_SETTINGS_KEY },
    create: {
      key: TRANSPORT_SETTINGS_KEY,
      value: JSON.stringify({
        allowHttp: false,
        a2aInlineBytes: 32 * 1024,
        a2aTaskFiles: 20,
      }),
    },
    update: {
      value: JSON.stringify({
        allowHttp: false,
        a2aInlineBytes: 32 * 1024,
        a2aTaskFiles: 20,
      }),
    },
  });
  await resetPrivateHostsSettings("test");

  const plat = await startMockServer(platformRequests, (req) => ({
    status: req.authorization === `Bearer ${PLATFORM_SECRET}` ? 200 : 401,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "platform", url: req.url }),
  }));
  platformServer = plat.server;
  platformOrigin = plat.origin;

  const cust = await startMockServer(customRequests, (req) => {
    if (req.url === "/echo-secret-400") {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        location: `${customOrigin}/redirect?secret=${CUSTOM_SECRET_A}`,
      };
      return {
        status: 400,
        headers,
        body: JSON.stringify({
          detail: `Upstream failed at ${customOrigin}/parse with ${CUSTOM_SECRET_A}`,
        }),
      };
    }
    if (customMode401 || req.authorization !== `Bearer ${CUSTOM_SECRET_A}`) {
      return {
        status: 401,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "unauthorized_custom" }),
      };
    }
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "custom", url: req.url }),
    };
  });
  customServer = cust.server;
  customOrigin = cust.origin;

  const suffix = randomUUID();
  const [adminUser, memberUser] = await Promise.all([
    db.user.create({
      data: {
        email: `admin-${suffix}@test.invalid`,
        passwordHash: "x",
        role: "admin",
      },
    }),
    db.user.create({
      data: {
        email: `member-${suffix}@test.invalid`,
        passwordHash: "x",
        role: "user",
      },
    }),
  ]);
  adminUserId = adminUser.id;
  memberUserId = memberUser.id;

  const [wsA, wsB] = await Promise.all([
    db.workspace.create({
      data: {
        slug: `ws-a-${suffix}`,
        name: "Workspace A",
        ownerId: memberUserId,
      },
    }),
    db.workspace.create({
      data: {
        slug: `ws-b-${suffix}`,
        name: "Workspace B",
        ownerId: memberUserId,
      },
    }),
  ]);
  wsAId = wsA.id;
  wsBId = wsB.id;

  const officialRegistry = await db.githubResourceRegistry.create({
    data: {
      workspaceId: null,
      official: true,
      name: "Official Test Registry",
      repository: `asharca/official-${suffix}`,
      branch: "main",
      visibility: "public",
      status: "ready",
    },
  });
  officialRegistryId = officialRegistry.id;

  const ocrManifest = buildPluginManifest({
    slug: `ocr-${suffix}`,
    env: [
      { name: "OCRPLANE_BASE_URL", required: true, secret: false, kind: "url" },
      { name: "OCRPLANE_API_KEY", required: true, secret: true },
    ],
    httpProxies: [
      {
        key: "ocrplane",
        baseUrlEnv: "OCRPLANE_BASE_URL",
        auth: { type: "bearer", secretEnv: "OCRPLANE_API_KEY" },
      },
    ],
  });
  const officialListing = await db.marketListing.create({
    data: {
      namespace: "asharca",
      slug: `ocr-${suffix}`,
      kind: "pi-package",
      name: "ocrplane-cli",
      metadata: {},
      status: "published",
    },
  });
  officialListingId = officialListing.id;
  const officialRelease = await db.marketRelease.create({
    data: {
      listingId: officialListingId,
      version: 1,
      manifest: ocrManifest,
      releaseSummary: { version: "2.1.0" },
      checksum: marketReleaseChecksum(ocrManifest),
      reviewStatus: "approved",
    },
  });
  officialReleaseId = officialRelease.id;
  await db.githubRegistryResource.create({
    data: {
      registryId: officialRegistryId,
      resourceId: "ocrplane-cli",
      kind: "pi-package",
      listingId: officialListingId,
      active: true,
    },
  });

  const nonProxyManifest = buildPluginManifest({
    slug: `non-proxy-${suffix}`,
    env: [{ name: "RAW_SECRET", required: true, secret: true }],
  });
  const nonProxyListing = await db.marketListing.create({
    data: {
      namespace: "asharca",
      slug: `non-proxy-${suffix}`,
      kind: "pi-package",
      name: "non-proxy-official",
      metadata: {},
      status: "published",
    },
  });
  nonProxyOfficialListingId = nonProxyListing.id;
  await db.marketRelease.create({
    data: {
      listingId: nonProxyOfficialListingId,
      version: 1,
      manifest: nonProxyManifest,
      releaseSummary: { version: "2.1.0" },
      checksum: marketReleaseChecksum(nonProxyManifest),
      reviewStatus: "approved",
    },
  });
  await db.githubRegistryResource.create({
    data: {
      registryId: officialRegistryId,
      resourceId: "non-proxy-official",
      kind: "pi-package",
      listingId: nonProxyOfficialListingId,
      active: true,
    },
  });

  const privateManifest = buildPluginManifest({
    slug: `priv-${suffix}`,
    env: [
      { name: "PRIVATE_SECRET", required: true, secret: true },
      { name: "PRIVATE_URL", required: false, secret: false, kind: "url" },
    ],
  });
  const privateListing = await db.marketListing.create({
    data: {
      namespace: suffix,
      slug: `priv-${suffix}`,
      kind: "pi-package",
      publisherWorkspaceId: wsAId,
      name: "private-plugin",
      metadata: {},
      status: "published",
    },
  });
  privateListingId = privateListing.id;
  privateReleaseId = (
    await db.marketRelease.create({
      data: {
        listingId: privateListingId,
        version: 1,
        manifest: privateManifest,
        releaseSummary: { version: "2.1.0" },
        checksum: marketReleaseChecksum(privateManifest),
        reviewStatus: "approved",
      },
    })
  ).id;
});

afterAll(async () => {
  await new Promise<void>((r) => platformServer.close(() => r()));
  await new Promise<void>((r) => customServer.close(() => r()));

  if (prevTransportSetting === null) {
    await db.systemSetting.deleteMany({
      where: { key: TRANSPORT_SETTINGS_KEY },
    });
  } else {
    await db.systemSetting.upsert({
      where: { key: TRANSPORT_SETTINGS_KEY },
      create: { key: TRANSPORT_SETTINGS_KEY, value: prevTransportSetting },
      update: { value: prevTransportSetting },
    });
  }
  if (prevPrivateHostsSetting === null) {
    await resetPrivateHostsSettings("test");
  } else {
    await db.systemSetting.upsert({
      where: { key: PRIVATE_HOSTS_SETTING_KEY },
      create: {
        key: PRIVATE_HOSTS_SETTING_KEY,
        value: prevPrivateHostsSetting,
      },
      update: { value: prevPrivateHostsSetting },
    });
  }

  if (wsAId) {
    await db.conversation.deleteMany({
      where: { agent: { workspaceId: { in: [wsAId, wsBId] } } },
    });
    await db.workspace.deleteMany({ where: { id: { in: [wsAId, wsBId] } } });
  }
  if (officialRegistryId) {
    await db.githubRegistryResource.deleteMany({
      where: { registryId: officialRegistryId },
    });
    await db.githubResourceRegistry.deleteMany({
      where: { id: officialRegistryId },
    });
  }
  await db.marketListing.deleteMany({
    where: {
      id: {
        in: [officialListingId, privateListingId, nonProxyOfficialListingId],
      },
    },
  });
  await db.user.deleteMany({
    where: { id: { in: [adminUserId, memberUserId] } },
  });
  await db.$disconnect();
});

it("enforces official preset rules, workspace isolation, strict no-fallback proxy routing, and fail-closed admission", async () => {
  const scopeA = await testWorkspaceScope(wsAId, memberUserId, "plugins");
  const scopeB = await testWorkspaceScope(wsBId, memberUserId, "plugins");

  // 1. Private plugins and unproxied-secret official plugins cannot save platform presets.
  await expect(
    saveOfficialPluginEnvPreset(adminUserId, privateListingId, {
      values: { PRIVATE_SECRET: "x" },
    }),
  ).rejects.toMatchObject({ code: "not_official_plugin" });
  await expect(
    saveOfficialPluginEnvPreset(adminUserId, nonProxyOfficialListingId, {
      values: { RAW_SECRET: "x" },
    }),
  ).rejects.toMatchObject({ code: "preset_unsupported" });

  // 2. Incomplete preset blocks default install & reports exact missing required keys.
  const preCatalog = await listPluginCards(scopeA, {
    query: "ocrplane-cli",
  });
  const preCard = preCatalog.items.find((p) => p.id === officialListingId);
  expect(preCard?.envStatus.presetComplete).toBe(false);
  expect(preCard?.envStatus.missingRequiredKeys).toEqual([
    "OCRPLANE_BASE_URL",
    "OCRPLANE_API_KEY",
  ]);
  await expect(addPlugin(scopeA, officialListingId)).rejects.toMatchObject({
    code: "env_config_incomplete",
  });

  // 3. Admin saves platform preset; audit log records only configuredKeys (zero secret values).
  const savedPreset = await saveOfficialPluginEnvPreset(
    adminUserId,
    officialListingId,
    {
      values: {
        OCRPLANE_BASE_URL: platformOrigin,
        OCRPLANE_API_KEY: PLATFORM_SECRET,
      },
    },
  );
  expect(savedPreset.presetComplete).toBe(true);
  const presetAudit = await db.auditEvent.findFirstOrThrow({
    where: { targetId: officialListingId, action: "plugin.preset.updated" },
    orderBy: { createdAt: "desc" },
  });
  expect(JSON.stringify(presetAudit.changes)).not.toContain(PLATFORM_SECRET);
  expect(JSON.stringify(presetAudit.changes)).not.toContain(platformOrigin);

  // 4. Default install in Workspace A selects platform_preset automatically without entering secrets.
  const installA = await addPlugin(scopeA, officialListingId);
  const listA = await listPlugins(scopeA, { installedOnly: true });
  const detailA = await getPlugin(scopeA, officialListingId);
  expect(listA.items[0].envStatus).toMatchObject({
    mode: "platform_preset",
    complete: true,
    missingRequiredKeys: [],
  });
  expect(JSON.stringify({ listA, detailA })).not.toContain(PLATFORM_SECRET);
  expect(JSON.stringify({ listA, detailA })).not.toContain(platformOrigin);

  // 5. Bind to an Agent, publish revision, create sandbox+conversation, and test live proxy runtime.
  const provider = await db.modelProvider.create({
    data: {
      workspaceId: wsAId,
      name: "Stub",
      format: "openai",
      baseUrl: "https://model.example.com/v1",
      apiKey: "model-key",
      models: ["gpt-test"],
    },
  });
  const agent = await createAgent(wsAId, "OCR Agent", {
    piPackages: [
      { marketInstallId: installA.id, releaseId: officialReleaseId },
    ],
  });
  await updateAgent(wsAId, agent.id, {
    name: "OCR Agent",
    systemPrompt: "",
    providerId: provider.id,
    model: "gpt-test",
    maxSteps: 10,
    piPackages: [
      { marketInstallId: installA.id, releaseId: officialReleaseId },
    ],
  });
  const revision = await publishFixtureAgentRevision(wsAId, agent.id);
  const deployment = await db.deployment.create({
    data: { workspaceId: wsAId },
  });
  const sandbox = await db.sandbox.create({
    data: {
      workspaceId: wsAId,
      name: "OCR Sandbox",
      slug: randomUUID(),
      deploymentId: deployment.id,
    },
  });
  const conversation = await db.conversation.create({
    data: {
      agentId: agent.id,
      sandboxId: sandbox.id,
      agentRevisionId: revision.id,
      legacyRevisionUnresolved: false,
    },
  });
  await resolvePiSessionPackages({
    workspaceId: wsAId,
    agentId: agent.id,
    sandboxId: sandbox.id,
    conversationId: conversation.id,
    runtimeSessionId: conversation.id,
  });

  const runtimeJwt = await createAgentRuntimeToken({
    workspaceId: wsAId,
    agentId: agent.id,
    agentRevisionId: revision.id,
    sandboxId: sandbox.id,
    conversationId: conversation.id,
    providerId: provider.id,
    deploymentIds: [],
    exp: Math.floor(Date.now() / 1000) + 300,
  });

  const officialReleaseRow = await db.marketRelease.findUniqueOrThrow({
    where: { id: officialReleaseId },
    select: { manifest: true, checksum: true },
  });
  const parsedOcrManifest = parsePiPackageReleaseManifest(
    officialReleaseRow.manifest,
    officialReleaseRow.checksum,
  );
  const turnEnvPlat = await prepareTurnPluginEnv({
    workspaceId: wsAId,
    agentId: agent.id,
    agentRevisionId: revision.id,
    sandboxId: sandbox.id,
    conversationId: conversation.id,
    runtimeAccessToken: runtimeJwt,
    packages: [
      {
        marketInstallId: installA.id,
        releaseId: officialReleaseId,
        manifest: parsedOcrManifest,
      },
    ],
  });

  const platProxyUrl = turnEnvPlat.env.OCRPLANE_BASE_URL;
  const platProxyJwt = turnEnvPlat.env.OCRPLANE_API_KEY;
  expect(platProxyUrl).toContain(
    `/api/v1/agent-runtime/plugins/${installA.id}/ocrplane`,
  );
  // CRITICAL: Sandbox env, sandboxRedactTokens, and signature must NEVER hold real platform secret or upstream URL.
  const sandboxPayload = JSON.stringify({
    env: turnEnvPlat.env,
    sandboxRedactTokens: turnEnvPlat.sandboxRedactTokens,
    signature: turnEnvPlat.signature,
  });
  expect(sandboxPayload).not.toContain(PLATFORM_SECRET);
  expect(sandboxPayload).not.toContain(platformOrigin);
  expect(turnEnvPlat.hostRedactTokens).toContain(PLATFORM_SECRET);
  expect(turnEnvPlat.hostRedactTokens).toContain(platProxyJwt);
  // Audience isolation: proxy JWT cannot authenticate runtime gateway.
  expect(await verifyAgentRuntimeToken(platProxyJwt)).toBeNull();

  // Origin header, wrong installId, wrong proxyKey rejected.
  const originDenied = await proxyPost(
    new Request(`${platProxyUrl}/api/parse`, {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        authorization: `Bearer ${platProxyJwt}`,
      },
    }),
    {
      params: Promise.resolve({
        installId: installA.id,
        proxyKey: "ocrplane",
        path: ["api", "parse"],
      }),
    },
  );
  expect(originDenied.status).toBe(403);

  const wrongProxyRes = await proxyPost(
    new Request(`${platProxyUrl}/api/parse`, {
      method: "POST",
      headers: { authorization: `Bearer ${platProxyJwt}` },
    }),
    {
      params: Promise.resolve({
        installId: installA.id,
        proxyKey: "other-proxy",
        path: ["api", "parse"],
      }),
    },
  );
  expect(wrongProxyRes.status).toBe(403);

  // Real multipart/form-data upload through proxy (admin preset allows private HTTP self-hosted service).
  const form = new FormData();
  form.set(
    "file",
    new Blob(["%PDF-1.4\ntest"], { type: "application/pdf" }),
    "doc.pdf",
  );
  const multipartRes = await proxyPost(
    new Request(`${platProxyUrl}/api/parse/sync`, {
      method: "POST",
      headers: { authorization: `Bearer ${platProxyJwt}` },
      body: form,
    }),
    {
      params: Promise.resolve({
        installId: installA.id,
        proxyKey: "ocrplane",
        path: ["api", "parse", "sync"],
      }),
    },
  );
  expect(multipartRes.status).toBe(200);
  expect(await multipartRes.json()).toEqual({
    source: "platform",
    url: "/api/parse/sync",
  });
  expect(platformRequests).toHaveLength(1);
  expect(platformRequests[0].authorization).toBe(`Bearer ${PLATFORM_SECRET}`);
  expect(platformRequests[0].contentType).toContain("multipart/form-data");
  expect(platformRequests[0].bodyText).toContain("doc.pdf");

  // Observability logs & export secrets never leak platform secret or upstream URL.
  await flushLogs();
  const proxyLogs = await db.logEvent.findMany({
    where: { eventName: "plugin.proxy.request" },
    include: { detail: true },
  });
  expect(proxyLogs.length).toBeGreaterThanOrEqual(1);
  expect(JSON.stringify(proxyLogs)).not.toContain(PLATFORM_SECRET);
  expect(JSON.stringify(proxyLogs)).not.toContain(platformOrigin);

  const exportSecrets = await collectSessionPluginSecretsForRedaction(
    wsAId,
    agent.id,
  );
  expect(exportSecrets).toContain(PLATFORM_SECRET);

  // 6. Workspace B switches to custom config; Workspace A remains isolated on platform preset.
  const installB = await addPlugin(scopeB, officialListingId);
  await updatePluginEnvConfig(scopeB, installB.id, {
    mode: "custom",
    values: {
      OCRPLANE_BASE_URL: customOrigin,
      OCRPLANE_API_KEY: CUSTOM_SECRET_B,
    },
  });
  const installBConfig = await db.marketInstallEnvConfig.findUniqueOrThrow({
    where: { installId: installB.id },
  });
  // Tamper scope test: decrypting Workspace B row under Workspace A scope fails closed.
  expect(() =>
    decryptMarketInstallCustomEnvValues(
      wsAId,
      installB.id,
      officialListingId,
      installBConfig.encryptedValues,
    ),
  ).toThrow();
  expect(
    (await listPlugins(scopeA, { installedOnly: true })).items[0].envStatus
      .mode,
  ).toBe("platform_preset");

  // 7. Workspace A switches to custom config: old platform JWT rejected immediately, SSRF enforced, zero fallback on 401!
  await updatePluginEnvConfig(scopeA, installA.id, {
    mode: "custom",
    values: {
      OCRPLANE_BASE_URL: customOrigin,
      OCRPLANE_API_KEY: CUSTOM_SECRET_A,
    },
  });
  const modeChangedRes = await proxyPost(
    new Request(`${platProxyUrl}/api/parse`, {
      method: "POST",
      headers: { authorization: `Bearer ${platProxyJwt}` },
    }),
    {
      params: Promise.resolve({
        installId: installA.id,
        proxyKey: "ocrplane",
        path: ["api", "parse"],
      }),
    },
  );
  expect(modeChangedRes.status).toBe(403);
  expect(await modeChangedRes.json()).toMatchObject({
    code: "PLUGIN_ENV_MODE_CHANGED",
  });

  const turnEnvCustom = await prepareTurnPluginEnv({
    workspaceId: wsAId,
    agentId: agent.id,
    agentRevisionId: revision.id,
    sandboxId: sandbox.id,
    conversationId: conversation.id,
    runtimeAccessToken: runtimeJwt,
    packages: [
      {
        marketInstallId: installA.id,
        releaseId: officialReleaseId,
        manifest: parsedOcrManifest,
      },
    ],
  });
  expect(turnEnvCustom.signature).not.toBe(turnEnvPlat.signature);
  const customProxyJwt = turnEnvCustom.env.OCRPLANE_API_KEY;

  // Before allowlisting HTTP / 127.0.0.1, custom mode blocks loopback SSRF cleanly.
  const ssrfBlocked = await proxyPost(
    new Request(`${platProxyUrl}/api/parse`, {
      method: "POST",
      headers: { authorization: `Bearer ${customProxyJwt}` },
    }),
    {
      params: Promise.resolve({
        installId: installA.id,
        proxyKey: "ocrplane",
        path: ["api", "parse"],
      }),
    },
  );
  expect(ssrfBlocked.status).toBe(403);
  expect(await ssrfBlocked.json()).toMatchObject({
    code: "PLUGIN_PROXY_NETWORK_BLOCKED",
  });
  expect(customRequests).toHaveLength(0);

  // Enable transport HTTP + allowlist 127.0.0.1 to verify strict custom proxy & zero platform fallback.
  await db.systemSetting.upsert({
    where: { key: TRANSPORT_SETTINGS_KEY },
    create: {
      key: TRANSPORT_SETTINGS_KEY,
      value: JSON.stringify({
        allowHttp: true,
        a2aInlineBytes: 32 * 1024,
        a2aTaskFiles: 20,
      }),
    },
    update: {
      value: JSON.stringify({
        allowHttp: true,
        a2aInlineBytes: 32 * 1024,
        a2aTaskFiles: 20,
      }),
    },
  });
  await updatePrivateHostsSettings("10.20.0.5", adminUserId);
  testHooks.allowLoopbackCustomAddress = true;

  const customOkRes = await proxyPost(
    new Request(`${platProxyUrl}/api/parse`, {
      method: "POST",
      headers: { authorization: `Bearer ${customProxyJwt}` },
    }),
    {
      params: Promise.resolve({
        installId: installA.id,
        proxyKey: "ocrplane",
        path: ["api", "parse"],
      }),
    },
  );
  expect(customOkRes.status).toBe(200);
  expect(customRequests[0].authorization).toBe(`Bearer ${CUSTOM_SECRET_A}`);

  // When custom upstream returns 401, proxy returns 401 and NEVER falls back to platformUpstream.
  const platformCountBefore = platformRequests.length;
  customMode401 = true;
  const custom401Res = await proxyPost(
    new Request(`${platProxyUrl}/api/parse`, {
      method: "POST",
      headers: { authorization: `Bearer ${customProxyJwt}` },
    }),
    {
      params: Promise.resolve({
        installId: installA.id,
        proxyKey: "ocrplane",
        path: ["api", "parse"],
      }),
    },
  );
  customMode401 = false;
  expect(custom401Res.status).toBe(401);
  expect(platformRequests.length).toBe(platformCountBefore);

  // Upstream 4xx body & Location header echoing custom secret/origin are redacted.
  const redaction400Res = await proxyPost(
    new Request(`${platProxyUrl}/echo-secret-400`, {
      method: "POST",
      headers: { authorization: `Bearer ${customProxyJwt}` },
    }),
    {
      params: Promise.resolve({
        installId: installA.id,
        proxyKey: "ocrplane",
        path: ["echo-secret-400"],
      }),
    },
  );
  expect(redaction400Res.status).toBe(400);
  const redacted400Body = await redaction400Res.text();
  expect(redacted400Body).not.toContain(CUSTOM_SECRET_A);
  expect(redacted400Body).not.toContain(customOrigin);
  expect(redaction400Res.headers.get("location") ?? "").not.toContain(
    CUSTOM_SECRET_A,
  );

  // 8. Model obfuscation helper only includes custom non-proxy secrets (never platform preset or proxy secrets).
  const privateInstall = await addPlugin(
    scopeA,
    privateListingId,
    {},
    {
      mode: "custom",
      values: { PRIVATE_SECRET: CUSTOM_RAW_SECRET },
    },
  );
  await updateAgent(wsAId, agent.id, {
    name: "OCR Agent",
    systemPrompt: "",
    providerId: provider.id,
    model: "gpt-test",
    maxSteps: 10,
    piPackages: [
      { marketInstallId: installA.id, releaseId: officialReleaseId },
      { marketInstallId: privateInstall.id, releaseId: privateReleaseId },
    ],
  });
  const rev2 = await publishFixtureAgentRevision(wsAId, agent.id);
  const modelSecrets = await collectSessionCustomNonProxyPluginSecrets({
    workspaceId: wsAId,
    agentId: agent.id,
    agentRevisionId: rev2.id,
  });
  expect(modelSecrets).toEqual({ PRIVATE_SECRET: CUSTOM_RAW_SECRET });
  expect(JSON.stringify(modelSecrets)).not.toContain(PLATFORM_SECRET);
  expect(JSON.stringify(modelSecrets)).not.toContain(CUSTOM_SECRET_A);

  // 9. Clearing platform preset fails closed for installs on platform_preset across catalog, agent draft, session & proxy!
  await updatePluginEnvConfig(scopeA, installA.id, { mode: "platform_preset" });
  await clearOfficialPluginEnvPreset(adminUserId, officialListingId);
  const brokenCards = await listPluginCards(scopeA, { query: "ocrplane-cli" });
  const brokenCard = brokenCards.items.find((p) => p.id === officialListingId);
  expect(brokenCard?.card.available).toBe(false);
  expect(brokenCard?.envStatus.missingRequiredKeys).toEqual([
    "OCRPLANE_BASE_URL",
    "OCRPLANE_API_KEY",
  ]);
  await expect(
    setAgentPiPackages(wsAId, agent.id, [
      { marketInstallId: installA.id, releaseId: officialReleaseId },
    ]),
  ).rejects.toThrow("PI_PACKAGE_ENV_INCOMPLETE");
  await expect(
    resolvePiSessionPackages({
      workspaceId: wsAId,
      agentId: agent.id,
      sandboxId: sandbox.id,
      conversationId: conversation.id,
      runtimeSessionId: conversation.id,
    }),
  ).rejects.toThrow("PI_PACKAGE_ENV_INCOMPLETE");
  const clearedPresetProxyRes = await proxyPost(
    new Request(`${platProxyUrl}/api/parse`, {
      method: "POST",
      headers: { authorization: `Bearer ${platProxyJwt}` },
    }),
    {
      params: Promise.resolve({
        installId: installA.id,
        proxyKey: "ocrplane",
        path: ["api", "parse"],
      }),
    },
  );
  expect(clearedPresetProxyRes.status).toBe(409);
  expect(await clearedPresetProxyRes.json()).toMatchObject({
    code: "PLUGIN_ENV_INCOMPLETE",
  });

  // 10. Revoking release fails proxy closed (after restoring preset).
  await saveOfficialPluginEnvPreset(adminUserId, officialListingId, {
    values: {
      OCRPLANE_BASE_URL: platformOrigin,
      OCRPLANE_API_KEY: PLATFORM_SECRET,
    },
  });
  await revokeDangerousMarketRelease({
    workspaceId: wsAId,
    userId: adminUserId,
    releaseId: officialReleaseId,
    reason: "Revoke check",
  });
  const revokedRes = await proxyPost(
    new Request(`${platProxyUrl}/api/parse`, {
      method: "POST",
      headers: { authorization: `Bearer ${platProxyJwt}` },
    }),
    {
      params: Promise.resolve({
        installId: installA.id,
        proxyKey: "ocrplane",
        path: ["api", "parse"],
      }),
    },
  );
  expect(revokedRes.status).toBe(403);
  expect(await revokedRes.json()).toMatchObject({
    code: "PLUGIN_PROXY_REVOKED",
  });
});
