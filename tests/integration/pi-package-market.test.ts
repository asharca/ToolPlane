// @vitest-environment node
import { assertDefined } from "../assert-defined";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  approveResourceMarketRelease,
  installOfficialPiPackage,
  installMarketRelease,
  publishPiPackageRelease,
  previewPiPackageSource,
  publishAssembledPiPackageRelease,
  updatePiPackageMcpBindings,
  previewAssembledPiPackage,
  updateMarketInstall,
} from "@/lib/market/resources";
import {
  listWorkspaceMarketInstalls,
  removeMarketInstall,
} from "@/lib/market/skills";
import { updateAgent } from "@/lib/agents/mutations";
import { resolveAgentPiPackages } from "@/lib/agents/resolve";
import { marketReleaseChecksum } from "@/lib/market/artifact";
import {
  parsePiPackageReleaseManifest,
  type PiPackageSnapshotV1,
} from "@/lib/market/pi-package-manifest";
import type * as PiPackageSourceModule from "@/lib/market/pi-package-source";
import type * as PiPackageNetworkModule from "@/lib/market/pi-package-network";
import { createApiToken, revokeApiToken } from "@/lib/auth/tokens";
import { getMarketListing } from "@/lib/market/listings";
import { listMarketListings } from "@/lib/market/listings";
import { getPiPackageDownload } from "@/lib/market/pi-package-archive";
import {
  POST as installHttp,
  GET as listInstalledHttp,
} from "@/app/api/v1/workspaces/[slug]/market/installs/route";
import { PATCH as updateInstallHttp } from "@/app/api/v1/workspaces/[slug]/market/installs/[installId]/route";
import { resolvePiSessionPackages } from "@/lib/agents/pi-session-packages";
import {
  assertMarketReleasesExecutable,
  revokeDangerousMarketRelease,
} from "@/lib/market/revocation";

import { publishFixtureAgentRevision } from "./agent-revision-fixture";
import { rollbackAgentRevision } from "@/lib/agents/revisions";
import { applyPiPackageToAgent } from "@/lib/market/pi-package-agent-apply";
import { preflightPiSdkCapabilities } from "@/lib/agents/sandbox-runtime";
import type * as SandboxRuntimeModule from "@/lib/agents/sandbox-runtime";
vi.mock("@/lib/agents/sandbox-runtime", async (original) => ({
  ...(await original<typeof SandboxRuntimeModule>()),
  preflightPiSdkCapabilities: vi
    .fn()
    .mockResolvedValue({ commands: [], tools: [], skills: [], prompts: [] }),
}));
const capture = vi.hoisted(() => vi.fn());
vi.mock("@/lib/market/pi-package-source", async (importOriginal) => ({
  ...(await importOriginal<typeof PiPackageSourceModule>()),
  capturePiPackage: capture,
}));
const sourceRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/market/pi-package-network", async (original) => ({
  ...(await original<typeof PiPackageNetworkModule>()),
  piSourceRequest: sourceRequest,
}));
const stamp = `${process.pid}-${Date.now()}`;
let publisher = "",
  installer = "",
  admin = "",
  sourceWorkspace = "",
  targetWorkspace = "",
  category = "";
let arch: "arm64" | "x64";
let sequence = 0;

function snapshot(
  version = "1.0.0",
  text = 'export default function(pi) { pi.registerCommand("Hello", { handler: async () => {} }); }',
): PiPackageSnapshotV1 {
  return {
    source: {
      kind: "npm",
      requested: `npm:fixture-extension@${version}`,
      name: "fixture-extension",
      version,
      integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
    },
    name: "fixture-extension",
    version,
    runtime: {
      kind: "pi-sdk",
      piVersion: "0.87.1",
      nodeMajor: 26,
      platform: "linux",
      arch,
    },
    root: "package",
    resources: {
      extensions: ["package/index.ts"],
      skills: [],
      prompts: [],
      themes: [],
    },
    entries: [
      { type: "directory", path: "package" },
      {
        type: "file",
        path: "package/index.ts",
        contentEncoding: "base64",
        content: Buffer.from(text).toString("base64"),
        executable: false,
        sha256: createHash("sha256").update(text).digest("hex"),
      },
    ],
  };
}
async function publish(slug = `extension-${++sequence}`, listingId?: string) {
  const preview = await previewPiPackageSource({
    workspaceId: sourceWorkspace,
    publishedById: publisher,
    source: "npm:fixture-extension@latest",
  });
  return publishPiPackageRelease({
    sourceDigest: preview.sourceDigest,
    workspaceId: sourceWorkspace,
    publishedById: publisher,
    source: "npm:fixture-extension@latest",
    visibility: "public",
    categoryIds: [category],
    listingId,
    listing: {
      slug,
      name: "Fixture extension",
      summary: "Reviewed executable extension",
    },
  });
}
async function approve(result: {
  listing: { id: string };
  release: { id: string };
}) {
  await approveResourceMarketRelease({
    listingId: result.listing.id,
    releaseId: result.release.id,
    reviewedById: admin,
  });
}
function install(releaseId: string, key = `install-${++sequence}`) {
  return installMarketRelease({
    releaseId,
    targetWorkspaceId: targetWorkspace,
    installedById: installer,
    idempotencyKey: key,
  });
}
async function agent(runtimeKind = "pi-sdk") {
  return db.agent.create({
    data: {
      workspaceId: targetWorkspace,
      name: "Fixture agent",
      slug: `agent-${++sequence}`,
      runtimeKind,
    },
  });
}
async function bind(
  agentId: string,
  piPackages: Array<{ marketInstallId: string; releaseId: string }>,
  workspaceId = targetWorkspace,
) {
  await updateAgent(workspaceId, agentId, {
    name: "Fixture agent",
    systemPrompt: null,
    providerId: null,
    model: null,
    maxSteps: 100,
    piPackages,
  });
}
async function loaded(agentId: string) {
  const value = await db.agent.findUniqueOrThrow({
    where: { id: agentId },
    include: {
      piPackages: {
        include: {
          marketInstall: { include: { listing: true } },
          release: true,
        },
      },
    },
  });
  return resolveAgentPiPackages(value);
}

describe.sequential("Pi package market lifecycle", () => {
  beforeAll(async () => {
    const domain = (
      await promisify(execFile)("docker", [
        "info",
        "--format",
        "{{.OSType}}/{{.Architecture}}",
      ])
    ).stdout.trim();
    expect(domain.split("/")[0]).toBe("linux");
    arch = /(?:aarch64|arm64)$/.test(domain) ? "arm64" : "x64";
    const users = await Promise.all(
      ["publisher", "installer", "admin"].map((role) =>
        db.user.create({
          data: {
            email: `pi-market-${role}-${stamp}@test.dev`,
            passwordHash: "x",
            ...(role === "admin" ? { role: "admin" } : {}),
          },
        }),
      ),
    );
    [publisher, installer, admin] = users.map((user) => user.id);
    const workspaces = await Promise.all(
      [publisher, installer].map((ownerId, i) =>
        db.workspace.create({
          data: {
            ownerId,
            slug: `pi-market-${i}-${stamp}`,
            name: `Pi market ${i}`,
            members: { create: { userId: ownerId, role: "owner" } },
          },
        }),
      ),
    );
    [sourceWorkspace, targetWorkspace] = workspaces.map(
      (workspace) => workspace.id,
    );
    category = (
      await db.category.create({
        data: { slug: `pi-market-${stamp}`, name: "Pi market" },
      })
    ).id;
  });
  beforeEach(() => {
    capture.mockReset();
    capture.mockResolvedValue(snapshot());
    sourceRequest.mockReset();
    sourceRequest.mockImplementation(async (url: URL) =>
      url.hostname === "pi.dev"
        ? Buffer.from(
            '<span class="packages-count">1-1 / 1</span><article data-package-card="true" data-package-name="fixture-extension"><p class="packages-desc">Official fixture</p></article>',
          )
        : Buffer.from(
            JSON.stringify({
              name: "fixture-extension",
              version: decodeURIComponent(
                assertDefined(url.pathname.split("/").at(-1)),
              ),
              dist: {
                integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
              },
            }),
          ),
    );
  });
  afterAll(async () => {
    const workspaceIds = [sourceWorkspace, targetWorkspace].filter(Boolean);
    await db.agent.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await db.marketInstall.deleteMany({
      where: { targetWorkspaceId: { in: workspaceIds } },
    });
    await db.marketListing.updateMany({
      where: { publisherWorkspaceId: { in: workspaceIds } },
      data: { latestReleaseId: null, pendingReleaseId: null },
    });
    await db.marketRelease.deleteMany({
      where: { listing: { publisherWorkspaceId: { in: workspaceIds } } },
    });
    await db.marketListing.deleteMany({
      where: { publisherWorkspaceId: { in: workspaceIds } },
    });
    await db.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await db.category.deleteMany({ where: { id: category } });
    await db.user.deleteMany({
      where: { id: { in: [publisher, installer, admin].filter(Boolean) } },
    });
  });

  it("installs official selections for members without human review and only manually updates workspace versions", async () => {
    await db.membership.create({
      data: { workspaceId: targetWorkspace, userId: publisher, role: "member" },
    });
    const input = {
      workspaceId: targetWorkspace,
      userId: publisher,
      name: "fixture-extension",
      version: "1.0.0",
    };
    try {
      const first = await installOfficialPiPackage(input);
      expect(first.install).toMatchObject({
        status: "ready",
        currentReleaseId: first.release.id,
        resourceMap: { kind: "pi-package" },
      });
      expect(first.release).toMatchObject({
        reviewStatus: "approved",
        reviewedById: null,
        reviewedAt: null,
        releaseSummary: { reviewPolicy: "official-directory" },
      });
      expect(
        (await listWorkspaceMarketInstalls(targetWorkspace)).find(
          (row) => row.id === first.install.id,
        )?.currentRelease,
      ).toMatchObject({ reviewPolicy: "official-directory" });
      const sdk = await agent();
      await bind(sdk.id, [
        { marketInstallId: first.install.id, releaseId: first.release.id },
      ]);
      expect((await installOfficialPiPackage(input)).install.id).toBe(
        first.install.id,
      );
      capture.mockResolvedValue(snapshot("2.0.0"));
      expect(
        (
          await db.marketInstall.findUniqueOrThrow({
            where: { id: first.install.id },
          })
        ).currentReleaseId,
      ).toBe(first.release.id);
      const next = await installOfficialPiPackage({
        ...input,
        version: "2.0.0",
      });
      expect(next.install).toMatchObject({
        id: first.install.id,
        currentReleaseId: next.release.id,
        requestedReleaseId: next.release.id,
      });
      expect((await loaded(sdk.id))[0].releaseId).toBe(first.release.id);
      await expect(
        approveResourceMarketRelease({
          listingId: next.install.listingId,
          releaseId: next.release.id,
          reviewedById: publisher,
        }),
      ).rejects.toMatchObject({ code: "not_authorized" });
      await expect(
        publishPiPackageRelease({
          workspaceId: targetWorkspace,
          publishedById: installer,
          source: "npm:fixture-extension",
          sourceDigest: marketReleaseChecksum(snapshot("2.0.0")),
          listingId: next.install.listingId,
          categoryIds: [category],
          listing: { slug: "ignored", name: "Custom" },
        }),
      ).rejects.toMatchObject({ code: "listing_conflict" });
    } finally {
      await db.membership.delete({
        where: {
          workspaceId_userId: {
            workspaceId: targetWorkspace,
            userId: publisher,
          },
        },
      });
    }
  });

  it("rejects unauthorized, forged directory selections, private registry substitution and tampered captured bytes", async () => {
    const input = {
      workspaceId: sourceWorkspace,
      userId: installer,
      name: "fixture-extension",
      version: "1.0.0",
    };
    await expect(installOfficialPiPackage(input)).rejects.toMatchObject({
      code: "not_authorized",
    });
    expect(capture).not.toHaveBeenCalled();
    input.userId = publisher;
    await expect(
      installOfficialPiPackage({
        ...input,
        name: "fixture-extension-impostor",
      }),
    ).rejects.toMatchObject({ code: "official_package_unavailable" });
    const count = await db.marketRelease.count({
      where: { listing: { publisherWorkspaceId: sourceWorkspace } },
    });
    const substituted = snapshot();
    if (substituted.source.kind !== "npm") throw new Error("fixture");
    substituted.source.registry = "https://private.example/";
    capture.mockResolvedValueOnce(substituted);
    await expect(installOfficialPiPackage(input)).rejects.toMatchObject({
      code: "official_package_unavailable",
    });
    const tampered = snapshot();
    const file = assertDefined(
      tampered.entries.find((entry) => entry.type === "file"),
    );
    if (file.type !== "file") throw new Error("fixture");
    file.content = Buffer.from("tampered").toString("base64");
    capture.mockResolvedValueOnce(tampered);
    await expect(installOfficialPiPackage(input)).rejects.toThrow();
    capture.mockResolvedValueOnce(
      snapshot("1.0.0", `export const token = "sk-proj-${"s".repeat(30)}";`),
    );
    await expect(installOfficialPiPackage(input)).rejects.toMatchObject({
      code: "invalid_manifest",
    });
    const incompatible = snapshot();
    incompatible.runtime.arch = arch === "arm64" ? "x64" : "arm64";
    capture.mockResolvedValueOnce(incompatible);
    await expect(installOfficialPiPackage(input)).rejects.toMatchObject({
      code: "package_platform_mismatch",
    });
    expect(
      await db.marketRelease.count({
        where: { listing: { publisherWorkspaceId: sourceWorkspace } },
      }),
    ).toBe(count);
    const custom = await publish();
    expect(custom.release.reviewStatus).toBe("pending");
    await expect(install(custom.release.id)).rejects.toMatchObject({
      code: "listing_unavailable",
    });
  });

  it("rechecks workspace access after official capture before creating a release", async () => {
    const input = {
      workspaceId: sourceWorkspace,
      userId: installer,
      name: "fixture-extension",
      version: "1.0.0",
    };
    await db.membership.create({
      data: { workspaceId: sourceWorkspace, userId: installer, role: "member" },
    });
    const count = await db.marketRelease.count({
      where: { listing: { publisherWorkspaceId: sourceWorkspace } },
    });
    capture.mockImplementationOnce(async () => {
      await db.membership.delete({
        where: {
          workspaceId_userId: {
            workspaceId: sourceWorkspace,
            userId: installer,
          },
        },
      });
      return snapshot();
    });
    await expect(installOfficialPiPackage(input)).rejects.toMatchObject({
      code: "not_authorized",
    });
    expect(
      await db.marketRelease.count({
        where: { listing: { publisherWorkspaceId: sourceWorkspace } },
      }),
    ).toBe(count);
  });

  it("does not adopt a custom listing whose slug collides with an official identity", async () => {
    const slug = `pi-official-${createHash("sha256").update("fixture-extension").digest("hex")}`;
    const custom = await publish(slug);
    await expect(
      installOfficialPiPackage({
        workspaceId: sourceWorkspace,
        userId: publisher,
        name: "fixture-extension",
        version: "1.0.0",
      }),
    ).rejects.toMatchObject({ code: "listing_conflict" });
    expect(
      (
        await db.marketRelease.findUniqueOrThrow({
          where: { id: custom.release.id },
        })
      ).reviewStatus,
    ).toBe("pending");
  });
  it("composes real Skills and scoped MCP requirements without serializing private bindings, and freezes pinned permissions", async () => {
    const skill = await db.installedSkill.create({
      data: {
        workspaceId: sourceWorkspace,
        name: "Review",
        slug: `review-${++sequence}`,
        content:
          "---\nname: review\ndescription: Review changes\n---\nRead the changed files.",
        files: [{ path: "reference.txt", content: "Reference content" }],
        source: "custom",
      },
    });
    const deployment = await db.deployment.create({
      data: {
        workspaceId: sourceWorkspace,
        name: "Search",
        source: "remote",
        sourceRef: "https://mcp.example.test",
        mcpToolExposure: "allowlist",
        mcpAllowedTools: ["search", "write"],
        installCfg: {
          toolCatalog: ["search", "write"].map((name) => ({
            name,
            inputSchema: { type: "object", properties: {} },
          })),
        },
      },
    });
    const base = {
      workspaceId: sourceWorkspace,
      publishedById: publisher,
      name: "composed-fixture",
      version: "1.0.0",
      categoryIds: [category],
      listing: { slug: `composed-${++sequence}`, name: "Composed" },
      installedSkillIds: [skill.id],
      mcps: [{ deploymentId: deployment.id, tools: ["search"] }],
    };
    await expect(
      publishAssembledPiPackageRelease({
        ...base,
        workspaceId: targetWorkspace,
        publishedById: installer,
        sourceDigest: "a".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "pi_package_source_unavailable" });
    const skillOnly = await publishAssembledPiPackageRelease({
      ...base,
      listing: { ...base.listing, slug: `skill-only-${++sequence}` },
      mcps: [],
      sourceDigest: (await previewAssembledPiPackage({ ...base, mcps: [] }))
        .sourceDigest,
    });
    expect(skillOnly.manifest.package.resources.extensions).toEqual([]);
    const v1 = await publishAssembledPiPackageRelease({
      ...base,
      sourceDigest: (await previewAssembledPiPackage(base)).sourceDigest,
    });
    const skillPath = v1.manifest.package.resources.skills[0];
    const skillEntry = v1.manifest.package.entries.find(
      (entry) => entry.path === skillPath,
    );
    expect(
      skillEntry?.type === "file" &&
        Buffer.from(skillEntry.content, "base64").toString("utf8"),
    ).toContain("Read the changed files.");
    expect(JSON.stringify(v1.manifest)).not.toContain(deployment.id);
    expect(JSON.stringify(v1.manifest)).not.toContain(sourceWorkspace);
    await approve(v1);
    const installed = await installMarketRelease({
      releaseId: v1.release.id,
      targetWorkspaceId: sourceWorkspace,
      installedById: publisher,
      idempotencyKey: `composed-${++sequence}`,
    });
    const key = assertDefined(v1.manifest.package.toolplane).mcp[0].key;
    const bindings = {
      [key]: { deploymentId: deployment.id, tools: ["search"] },
    };
    expect(installed.install.resourceMap).toEqual({
      kind: "pi-package",
      mcpBindings: bindings,
    });
    const setter = {
      workspaceId: sourceWorkspace,
      userId: publisher,
      marketInstallId: installed.install.id,
      mcpBindings: bindings,
    };
    await expect(
      updatePiPackageMcpBindings({ ...setter, userId: installer }),
    ).rejects.toMatchObject({ code: "not_authorized" });
    await expect(
      updatePiPackageMcpBindings({
        ...setter,
        mcpBindings: {
          [key]: { deploymentId: deployment.id, tools: ["search", "write"] },
        },
      }),
    ).rejects.toMatchObject({ code: "pi_package_invalid_bindings" });
    const sdk = await db.agent.create({
      data: {
        workspaceId: sourceWorkspace,
        name: "Bound",
        slug: `bound-${++sequence}`,
        runtimeKind: "pi-sdk",
        piPackages: {
          create: {
            marketInstallId: installed.install.id,
            releaseId: v1.release.id,
          },
        },
      },
    });
    await db.agentServer.create({
      data: {
        agentId: sdk.id,
        deploymentId: deployment.id,
        allowedToolNames: ["search", "write"],
      },
    });
    const revision = await publishFixtureAgentRevision(sourceWorkspace, sdk.id);
    const conversation = await db.conversation.create({
      data: {
        agentId: sdk.id,
        agentRevisionId: revision.id,
        legacyRevisionUnresolved: false,
      },
    });
    const sessionDeployment = await db.deployment.create({
      data: { workspaceId: sourceWorkspace },
    });
    const sessionSandbox = await db.sandbox.create({
      data: {
        workspaceId: sourceWorkspace,
        deploymentId: sessionDeployment.id,
        name: "Owned session",
        slug: `session-${++sequence}`,
      },
    });
    await db.conversation.update({
      where: { id: conversation.id },
      data: { sandboxId: sessionSandbox.id },
    });
    const sessionInput = {
      workspaceId: sourceWorkspace,
      agentId: sdk.id,
      sandboxId: sessionSandbox.id,
      conversationId: conversation.id,
      runtimeSessionId: conversation.id,
    };
    expect(
      (await resolvePiSessionPackages(sessionInput)).packages[0].releaseId,
    ).toBe(v1.release.id);
    await db.agentServer.updateMany({
      where: { agentId: sdk.id, deploymentId: deployment.id },
      data: { allowedToolNames: ["search"] },
    });
    expect(
      (await resolvePiSessionPackages(sessionInput)).packages[0].releaseId,
    ).toBe(v1.release.id);
    await db.agentServer.updateMany({
      where: { agentId: sdk.id, deploymentId: deployment.id },
      data: { allowedToolNames: [] },
    });
    await expect(resolvePiSessionPackages(sessionInput)).rejects.toThrow(
      "AGENT_GRANT_REVOKED",
    );
    await db.agentServer.updateMany({
      where: { agentId: sdk.id, deploymentId: deployment.id },
      data: { allowedToolNames: ["search"] },
    });
    expect(
      (await resolvePiSessionPackages(sessionInput)).packageDeploymentIds,
    ).toEqual([deployment.id]);
    await db.agentServer.deleteMany({
      where: { agentId: sdk.id, deploymentId: deployment.id },
    });
    await expect(resolvePiSessionPackages(sessionInput)).rejects.toThrow(
      "AGENT_GRANT_REVOKED",
    );
    await db.agentServer.create({
      data: {
        agentId: sdk.id,
        deploymentId: deployment.id,
        allowedToolNames: ["search"],
      },
    });
    const replacement = await db.deployment.create({
      data: {
        workspaceId: sourceWorkspace,
        name: "Replacement Search",
        source: "remote",
        sourceRef: "https://mcp.example.test/replacement",
        mcpToolExposure: "allowlist",
        mcpAllowedTools: ["search", "write"],
        installCfg: deployment.installCfg as Prisma.InputJsonValue,
      },
    });
    await updatePiPackageMcpBindings({
      ...setter,
      mcpBindings: {
        [key]: { deploymentId: replacement.id, tools: ["search"] },
      },
    });
    await expect(resolvePiSessionPackages(sessionInput)).rejects.toThrow(
      "PI_PACKAGE_MCP_BINDING_REQUIRED",
    );
    await updatePiPackageMcpBindings(setter);
    expect(
      (await resolvePiSessionPackages(sessionInput)).packages[0].releaseId,
    ).toBe(v1.release.id);
    const work = await db.workSession.create({
      data: {
        workspaceId: sourceWorkspace,
        agentId: sdk.id,
        conversationId: conversation.id,
        agentRevisionId: revision.id,
        legacyRevisionUnresolved: false,
        runtimeKind: "pi-sdk",
        status: "running",
      },
    });
    await expect(updatePiPackageMcpBindings(setter)).rejects.toMatchObject({
      code: "pi_package_agent_busy",
    });
    await db.workSession.update({
      where: { id: work.id },
      data: { status: "completed" },
    });
    await updatePiPackageMcpBindings(setter);
    const v2 = await publishAssembledPiPackageRelease({
      ...base,
      listingId: v1.listing.id,
      version: "2.0.0",
      mcps: [{ deploymentId: deployment.id, tools: ["search", "write"] }],
      sourceDigest: (
        await previewAssembledPiPackage({
          ...base,
          version: "2.0.0",
          mcps: [{ deploymentId: deployment.id, tools: ["search", "write"] }],
        })
      ).sourceDigest,
    });
    await approve(v2);
    await expect(
      updateMarketInstall({
        installId: installed.install.id,
        targetWorkspaceId: sourceWorkspace,
        actorId: publisher,
      }),
    ).rejects.toMatchObject({ code: "pi_package_mcp_binding_required" });
    const credential = await createApiToken(
      publisher,
      "Explicit capability update fixture",
    );
    const workspace = await db.workspace.findUniqueOrThrow({
      where: { id: sourceWorkspace },
    });
    const params = Promise.resolve({
      slug: workspace.slug,
      installId: installed.install.id,
    });
    const nextBindings = {
      [key]: { deploymentId: deployment.id, tools: ["search", "write"] },
    };
    try {
      const body = {
        action: "update",
        currentReleaseId: v1.release.id,
        targetReleaseId: v2.release.id,
        mcpBindings: nextBindings,
      };
      const headers = {
        authorization: `Bearer ${credential.token}`,
        "content-type": "application/json",
      };
      const unconfirmed = await updateInstallHttp(
        new Request("http://localhost/update", {
          method: "PATCH",
          headers,
          body: JSON.stringify(body),
        }),
        { params },
      );
      expect(unconfirmed.status).toBe(400);
      expect(
        (
          await db.marketInstall.findUniqueOrThrow({
            where: { id: installed.install.id },
          })
        ).currentReleaseId,
      ).toBe(v1.release.id);
      const foreign = await db.deployment.create({
        data: {
          workspaceId: targetWorkspace,
          name: "Foreign capability target",
        },
      });
      const denied = await updateInstallHttp(
        new Request("http://localhost/update", {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            ...body,
            confirmExpandedPrivileges: true,
            mcpBindings: {
              [key]: { deploymentId: foreign.id, tools: ["search", "write"] },
            },
          }),
        }),
        { params },
      );
      expect(denied.status).toBe(409);
      expect(
        (
          await db.marketInstall.findUniqueOrThrow({
            where: { id: installed.install.id },
          })
        ).currentReleaseId,
      ).toBe(v1.release.id);
      const confirmed = await updateInstallHttp(
        new Request("http://localhost/update", {
          method: "PATCH",
          headers,
          body: JSON.stringify({ ...body, confirmExpandedPrivileges: true }),
        }),
        { params },
      );
      expect(confirmed.status).toBe(200);
      await db.marketInstall.update({
        where: { id: installed.install.id },
        data: { resourceMap: { kind: "pi-package" } },
      });
      const repaired = await updateInstallHttp(
        new Request("http://localhost/update", {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            ...body,
            currentReleaseId: v2.release.id,
            confirmExpandedPrivileges: true,
          }),
        }),
        { params },
      );
      expect(repaired.status).toBe(200);
      expect(
        (
          await db.marketInstall.findUniqueOrThrow({
            where: { id: installed.install.id },
          })
        ).resourceMap,
      ).toEqual({ kind: "pi-package", mcpBindings: nextBindings });
    } finally {
      await revokeApiToken(publisher, credential.record.id);
    }
    await expect(
      updatePiPackageMcpBindings({
        ...setter,
        mcpBindings: {
          [key]: { deploymentId: deployment.id, tools: ["search", "write"] },
        },
      }),
    ).rejects.toMatchObject({ code: "pi_package_invalid_bindings" });
    expect(
      (
        await db.marketInstall.findUniqueOrThrow({
          where: { id: installed.install.id },
        })
      ).resourceMap,
    ).toEqual({
      kind: "pi-package",
      mcpBindings: {
        [key]: { deploymentId: deployment.id, tools: ["search", "write"] },
      },
    });
    const rolledBack = await updateMarketInstall({
      installId: installed.install.id,
      targetWorkspaceId: sourceWorkspace,
      actorId: publisher,
      currentReleaseId: v2.release.id,
      targetReleaseId: v1.release.id,
    });
    expect(rolledBack).toMatchObject({
      currentReleaseId: v1.release.id,
      requestedReleaseId: v1.release.id,
    });
    expect(
      (
        await db.agentPiPackage.findUniqueOrThrow({
          where: {
            agentId_marketInstallId: {
              agentId: sdk.id,
              marketInstallId: installed.install.id,
            },
          },
        })
      ).releaseId,
    ).toBe(v1.release.id);
    expect(
      (await resolvePiSessionPackages(sessionInput)).packages[0].releaseId,
    ).toBe(v1.release.id);
    await db.marketRelease.update({
      where: { id: v1.release.id },
      data: { reviewStatus: "rejected" },
    });
    await expect(
      updateMarketInstall({
        installId: installed.install.id,
        targetWorkspaceId: sourceWorkspace,
        actorId: publisher,
        currentReleaseId: v1.release.id,
        targetReleaseId: v1.release.id,
      }),
    ).rejects.toMatchObject({ code: "listing_unavailable" });
    await db.marketRelease.update({
      where: { id: v1.release.id },
      data: { reviewStatus: "approved" },
    });
    await removeMarketInstall({
      installId: installed.install.id,
      targetWorkspaceId: sourceWorkspace,
      actorId: publisher,
    });
    const uninstalledDefault = await db.agentRevision.findUniqueOrThrow({
      where: {
        agentId_version: { agentId: sdk.id, version: revision.version + 1 },
      },
    });
    expect(uninstalledDefault.config).toEqual({
      ...revision.config,
      packages: [],
    });
    expect(
      (
        await db.agentServer.findUniqueOrThrow({
          where: {
            agentId_deploymentId: {
              agentId: sdk.id,
              deploymentId: deployment.id,
            },
          },
        })
      ).allowedToolNames,
    ).toEqual(["search"]);
    expect(
      (await resolvePiSessionPackages(sessionInput)).packages[0].releaseId,
    ).toBe(v1.release.id);
    await db.agentServer.updateMany({
      where: { agentId: sdk.id, deploymentId: deployment.id },
      data: { allowedToolNames: [] },
    });
    await expect(resolvePiSessionPackages(sessionInput)).rejects.toThrow(
      "AGENT_GRANT_REVOKED",
    );
    await db.agentServer.deleteMany({
      where: { agentId: sdk.id, deploymentId: deployment.id },
    });
    await expect(resolvePiSessionPackages(sessionInput)).rejects.toThrow(
      "AGENT_GRANT_REVOKED",
    );
  });

  it.each(["git", "zip", "dependency"] as const)(
    "pins the full %s preview without publishing or leaking bytes",
    async (kind) => {
      const baseline = snapshot();
      const archive = new File(["preview upload"], "preview.zip");
      if (kind === "git")
        baseline.source = {
          kind: "git",
          requested: "https://github.com/example/package#main",
          url: "https://github.com/example/package",
          commit: "a".repeat(40),
        };
      if (kind === "zip") {
        const sha256 = createHash("sha256")
          .update(Buffer.from(await archive.arrayBuffer()))
          .digest("hex");
        baseline.source = {
          kind: "zip",
          requested: `zip:sha256:${sha256}`,
          sha256,
        };
      }
      const input = {
        workspaceId: sourceWorkspace,
        publishedById: publisher,
        ...(kind === "zip"
          ? { sourceType: "zip" as const, archive, confirmExecutableCode: true }
          : { source: baseline.source.requested }),
      };
      const before = await db.marketListing.count({
        where: { publisherWorkspaceId: sourceWorkspace },
      });
      capture.mockResolvedValueOnce(baseline);
      const preview = await previewPiPackageSource(input);
      expect(preview).toMatchObject({
        sourceDigest: marketReleaseChecksum(baseline),
        name: baseline.name,
        resources: baseline.resources,
        runtime: baseline.runtime,
      });
      expect(JSON.stringify(preview)).not.toContain("contentEncoding");
      expect(JSON.stringify(preview)).not.toContain("export default");
      expect(
        await db.marketListing.count({
          where: { publisherWorkspaceId: sourceWorkspace },
        }),
      ).toBe(before);
      const changed = structuredClone(baseline);
      if (changed.source.kind === "git") changed.source.commit = "b".repeat(40);
      else if (changed.source.kind === "zip") {
        changed.source.sha256 = "b".repeat(64);
        changed.source.requested = `zip:sha256:${changed.source.sha256}`;
      } else {
        const bytes = Buffer.from("module.exports = 'changed dependency';");
        changed.entries.push(
          { type: "directory", path: "package/node_modules" },
          { type: "directory", path: "package/node_modules/dependency" },
          {
            type: "file",
            path: "package/node_modules/dependency/index.js",
            contentEncoding: "base64",
            content: bytes.toString("base64"),
            executable: false,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        );
      }
      capture.mockResolvedValueOnce(changed);
      await expect(
        publishPiPackageRelease({
          ...input,
          sourceDigest: preview.sourceDigest,
          categoryIds: [category],
          listing: { slug: `stale-${++sequence}`, name: "Stale preview" },
        }),
      ).rejects.toMatchObject({ code: "source_changed" });
      expect(
        await db.marketListing.count({
          where: { publisherWorkspaceId: sourceWorkspace },
        }),
      ).toBe(before);
    },
  );
  it("distinguishes missing ZIP consent from workspace authorization and rejects both before capture", async () => {
    const calls = capture.mock.calls.length;
    await expect(
      previewPiPackageSource({
        workspaceId: sourceWorkspace,
        publishedById: installer,
        source: "npm:fixture",
      }),
    ).rejects.toMatchObject({ code: "not_authorized" });
    await expect(
      previewPiPackageSource({
        workspaceId: sourceWorkspace,
        publishedById: publisher,
        sourceType: "zip",
        archive: new File(["zip"], "pi.zip"),
        confirmExecutableCode: false,
      }),
    ).rejects.toMatchObject({
      code: "pi_package_executable_confirmation_required",
    });
    expect(capture.mock.calls).toHaveLength(calls);
  });

  it("requires explicit ZIP consent, trusts only private workspace use, and republishes frozen bytes for human review", async () => {
    const archive = new File(["fixture ZIP transport"], "pi.zip");
    const sha256 = createHash("sha256")
      .update(Buffer.from(await archive.arrayBuffer()))
      .digest("hex");
    const uploaded = snapshot();
    uploaded.source = {
      kind: "zip",
      requested: `zip:sha256:${sha256}`,
      sha256,
    };
    const input = {
      workspaceId: sourceWorkspace,
      publishedById: publisher,
      sourceType: "zip" as const,
      archive,
      confirmExecutableCode: false,
      categoryIds: [category],
      listing: { slug: `zip-private-${++sequence}`, name: `ZIP ${stamp}` },
    };
    await expect(publishPiPackageRelease(input)).rejects.toMatchObject({
      code: "pi_package_executable_confirmation_required",
    });
    capture.mockResolvedValueOnce(uploaded);
    const preview = await previewPiPackageSource({
      ...input,
      confirmExecutableCode: true,
    });
    capture.mockResolvedValueOnce(uploaded);
    const trusted = await publishPiPackageRelease({
      ...input,
      confirmExecutableCode: true,
      sourceDigest: preview.sourceDigest,
    });
    expect(trusted.listing).toMatchObject({
      visibility: "private",
      status: "published",
      latestReleaseId: trusted.release.id,
      pendingReleaseId: null,
    });
    expect(trusted.release).toMatchObject({
      reviewStatus: "approved",
      reviewedById: null,
      reviewedAt: null,
      releaseSummary: {
        reviewPolicy: "workspace-owner-trust",
        authorizedById: publisher,
      },
    });
    const filters = {
      kind: "pi-package",
      q: trusted.listing.slug,
      sourceKind: "zip",
      runtime: "pi-sdk" as const,
      pageSize: 1,
    };
    const cards = await listMarketListings({
      ...filters,
      viewer: { workspaceId: sourceWorkspace, userId: publisher },
    });
    expect(cards.total).toBe(1);
    expect(cards.items).toMatchObject([
      {
        sourceKind: "zip",
        runtimeCompatibility: {
          runtime: "pi-sdk",
          piVersion: "0.87.1",
          nodeMajor: 26,
        },
        latestRelease: { id: trusted.release.id },
      },
    ]);
    expect((await listMarketListings(filters)).total).toBe(0);
    expect(
      (
        await listMarketListings({
          ...filters,
          runtime: "mcp",
          viewer: { workspaceId: sourceWorkspace, userId: publisher },
        })
      ).total,
    ).toBe(0);
    expect(
      await getMarketListing(trusted.listing.namespace, trusted.listing.slug),
    ).toBeNull();
    await expect(install(trusted.release.id)).rejects.toMatchObject({
      code: "listing_unavailable",
    });
    await expect(
      getPiPackageDownload({
        workspaceId: targetWorkspace,
        userId: installer,
        releaseId: trusted.release.id,
      }),
    ).rejects.toThrow("listing_unavailable");
    expect(
      (
        await getPiPackageDownload({
          workspaceId: sourceWorkspace,
          userId: publisher,
          releaseId: trusted.release.id,
        })
      ).checksum,
    ).toBe(trusted.release.checksum);
    const localInstall = await installMarketRelease({
      releaseId: trusted.release.id,
      targetWorkspaceId: sourceWorkspace,
      installedById: publisher,
      idempotencyKey: `private-zip-${++sequence}`,
    });
    expect(localInstall.install).toMatchObject({
      status: "ready",
      currentReleaseId: trusted.release.id,
    });
    await expect(
      publishPiPackageRelease({
        ...input,
        confirmExecutableCode: true,
        sourceDigest: preview.sourceDigest,
        listingId: trusted.listing.id,
        visibility: "public",
      }),
    ).rejects.toMatchObject({ code: "listing_conflict" });
    const publicSubmission = await publishPiPackageRelease({
      workspaceId: sourceWorkspace,
      publishedById: publisher,
      sourceType: "release",
      targetReleaseId: trusted.release.id,
      visibility: "public",
      categoryIds: [category],
      listing: {
        slug: `zip-public-${++sequence}`,
        name: `Public ZIP ${stamp}`,
      },
    });
    expect(publicSubmission.release.reviewStatus).toBe("pending");
    expect(
      parsePiPackageReleaseManifest(publicSubmission.release.manifest).package
        .entries,
    ).toEqual(uploaded.entries);
    expect(
      parsePiPackageReleaseManifest(publicSubmission.release.manifest).package
        .source.kind,
    ).toBe("zip");
    await expect(
      publishPiPackageRelease({
        workspaceId: targetWorkspace,
        publishedById: installer,
        sourceType: "release",
        targetReleaseId: trusted.release.id,
        visibility: "public",
        categoryIds: [category],
        listing: { slug: `stolen-${++sequence}`, name: "Denied" },
      }),
    ).rejects.toMatchObject({ code: "source_not_found" });
  });
  it("records the same explicit workspace trust for npm/Git without making it public approval", async () => {
    const result = await publishPiPackageRelease({
      workspaceId: sourceWorkspace,
      publishedById: publisher,
      source: "npm:fixture-extension@latest",
      sourceDigest: marketReleaseChecksum(snapshot()),
      confirmExecutableCode: true,
      categoryIds: [category],
      listing: { slug: `trusted-npm-${++sequence}`, name: "Trusted npm" },
    });
    expect(result.release).toMatchObject({
      reviewStatus: "approved",
      reviewedById: null,
      releaseSummary: { reviewPolicy: "workspace-owner-trust" },
    });
    expect(result.listing.visibility).toBe("private");
  });

  it("keeps default-private imports out of public discovery, cross-workspace installs and artifact downloads", async () => {
    const pending = await publishPiPackageRelease({
      workspaceId: sourceWorkspace,
      publishedById: publisher,
      source: "npm:fixture-extension@latest",
      sourceDigest: marketReleaseChecksum(snapshot()),
      categoryIds: [category],
      listing: { slug: `private-${++sequence}`, name: `Private ${stamp}` },
    });
    expect(pending.listing.visibility).toBe("private");
    await approve(pending);
    expect(
      await getMarketListing(pending.listing.namespace, pending.listing.slug),
    ).toBeNull();
    expect(
      await getMarketListing(pending.listing.namespace, pending.listing.slug, {
        workspaceId: targetWorkspace,
        userId: installer,
      }),
    ).toBeNull();
    expect(
      await getMarketListing(pending.listing.namespace, pending.listing.slug, {
        workspaceId: sourceWorkspace,
        userId: installer,
      }),
    ).toBeNull();
    expect(
      await getMarketListing(pending.listing.namespace, pending.listing.slug, {
        workspaceId: sourceWorkspace,
        userId: publisher,
      }),
    ).toMatchObject({ id: pending.listing.id });
    expect(
      (await listMarketListings({ kind: "pi-package", q: `Private ${stamp}` }))
        .items,
    ).toEqual([]);
    await expect(install(pending.release.id)).rejects.toMatchObject({
      code: "listing_unavailable",
    });
    await expect(
      getPiPackageDownload({
        workspaceId: targetWorkspace,
        userId: installer,
        releaseId: pending.release.id,
      }),
    ).rejects.toThrow("listing_unavailable");
    const artifact = await getPiPackageDownload({
      workspaceId: sourceWorkspace,
      userId: publisher,
      releaseId: pending.release.id,
    });
    expect(artifact.checksum).toBe(pending.release.checksum);
    expect(artifact.archive.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
  });
  it("requires publisher/admin authorization and approval, then installs only a ready package row idempotently", async () => {
    await expect(
      publishPiPackageRelease({
        workspaceId: sourceWorkspace,
        publishedById: installer,
        source: "npm:fixture-extension",
        sourceDigest: marketReleaseChecksum(snapshot()),
        categoryIds: [category],
        listing: { slug: "denied", name: "Denied" },
      }),
    ).rejects.toMatchObject({ code: "not_authorized" });
    const release = await publish();
    await expect(install(release.release.id)).rejects.toMatchObject({
      code: "listing_unavailable",
    });
    await expect(
      approveResourceMarketRelease({
        listingId: release.listing.id,
        releaseId: release.release.id,
        reviewedById: publisher,
      }),
    ).rejects.toMatchObject({ code: "not_authorized" });
    await approve(release);
    const result = await install(release.release.id, "same-key");
    expect(result).toMatchObject({
      kind: "pi-package",
      resource: null,
      install: {
        status: "ready",
        deploymentId: null,
        installedSkillId: null,
        toolkitId: null,
        resourceMap: { kind: "pi-package" },
        requirements: {},
      },
    });
    expect((await install(release.release.id, "same-key")).install.id).toBe(
      result.install.id,
    );
    await expect(
      installMarketRelease({
        releaseId: release.release.id,
        targetWorkspaceId: targetWorkspace,
        installedById: publisher,
        idempotencyKey: "unauthorized",
      }),
    ).rejects.toMatchObject({ code: "not_authorized" });
  });

  it("returns an install-only HTTP resource and safe original-checksum projections using a real account token", async () => {
    const release = await publish();
    await approve(release);
    const workspace = await db.workspace.findUniqueOrThrow({
      where: { id: targetWorkspace },
    });
    const credential = await createApiToken(
      installer,
      "Isolated Pi package API fixture",
    );
    const headers = {
      authorization: `Bearer ${credential.token}`,
      "content-type": "application/json",
    };
    const params = Promise.resolve({ slug: workspace.slug });
    try {
      const response = await installHttp(
        new Request("http://localhost/api/v1/workspaces/test/market/installs", {
          method: "POST",
          headers,
          body: JSON.stringify({
            releaseId: release.release.id,
            idempotencyKey: `http-${++sequence}`,
          }),
        }),
        { params },
      );
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body).toMatchObject({
        kind: "pi-package",
        resourceId: null,
        status: "ready",
        reused: false,
      });
      const sdk = await agent();
      await bind(sdk.id, [
        { marketInstallId: body.installId, releaseId: release.release.id },
      ]);
      const detail = await getMarketListing(
        release.listing.namespace,
        release.listing.slug,
      );
      expect(detail).toMatchObject({
        latestRelease: { manifest: null, checksum: release.release.checksum },
        piPackage: {
          name: "fixture-extension",
          version: "1.0.0",
          fileCount: 1,
        },
      });
      const installed = await listInstalledHttp(
        new Request("http://localhost/api/v1/workspaces/test/market/installs", {
          headers,
        }),
        { params },
      );
      expect(installed.status).toBe(200);
      const listing = (await installed.json()).items.find(
        (item: { id: string }) => item.id === body.installId,
      );
      expect(listing).toMatchObject({
        currentRelease: {
          id: release.release.id,
          piPackage: { version: "1.0.0" },
        },
        agentPiPackages: [
          {
            agent: { id: sdk.id, runtimeKind: "pi-sdk" },
            releaseId: release.release.id,
          },
        ],
      });
      expect(JSON.stringify(listing)).not.toContain("contentEncoding");
      expect(JSON.stringify(detail)).not.toContain("contentEncoding");
    } finally {
      await revokeApiToken(installer, credential.record.id);
    }
  });

  it("retains every Agent pin during workspace updates and applies an approved version only explicitly", async () => {
    const v1 = await publish();
    await approve(v1);
    const installed = await install(v1.release.id);
    const sdk = await agent();
    const historical = await agent("pi");
    const binding = {
      marketInstallId: installed.install.id,
      releaseId: v1.release.id,
    };
    await bind(sdk.id, [binding]);
    const other = await agent();
    await bind(other.id, [binding]);
    await expect(bind(historical.id, [binding])).rejects.toThrow(
      "Historical Agents are read-only",
    );
    expect(await loaded(historical.id)).toEqual([]);
    expect(
      await db.agentPiPackage.count({ where: { agentId: historical.id } }),
    ).toBe(0);
    capture.mockResolvedValue(snapshot("2.0.0"));
    const v2 = await publish(v1.listing.slug, v1.listing.id);
    await approve(v2);
    await db.marketInstall.update({
      where: { id: installed.install.id },
      data: { ignoredReleaseId: v2.release.id },
    });
    const updated = await updateMarketInstall({
      installId: installed.install.id,
      targetWorkspaceId: targetWorkspace,
      actorId: installer,
      targetReleaseId: v2.release.id,
      currentReleaseId: v1.release.id,
    });
    expect(updated).toMatchObject({
      currentReleaseId: v2.release.id,
      requestedReleaseId: v2.release.id,
      ignoredReleaseId: null,
    });
    expect((await loaded(sdk.id))[0].releaseId).toBe(v1.release.id);
    expect((await loaded(other.id))[0].releaseId).toBe(v1.release.id);
    const fresh = await agent();
    await bind(fresh.id, [binding]);
    const revision = await publishFixtureAgentRevision(targetWorkspace, sdk.id);
    const conversation = await db.conversation.create({
      data: {
        agentId: sdk.id,
        agentRevisionId: revision.id,
        legacyRevisionUnresolved: false,
      },
    });
    const work = await db.workSession.create({
      data: {
        workspaceId: targetWorkspace,
        agentId: sdk.id,
        conversationId: conversation.id,
        agentRevisionId: revision.id,
        legacyRevisionUnresolved: false,
        runtimeKind: "pi-sdk",
        status: "running",
      },
    });
    await expect(
      bind(sdk.id, [{ ...binding, releaseId: v2.release.id }]),
    ).rejects.toThrow("pi_package_agent_busy");
    expect((await loaded(sdk.id))[0].releaseId).toBe(v1.release.id);
    await db.workSession.update({
      where: { id: work.id },
      data: { status: "completed" },
    });
    await bind(sdk.id, [{ ...binding, releaseId: v2.release.id }]);
    expect((await loaded(sdk.id))[0].manifest.package.version).toBe("2.0.0");
    expect((await loaded(other.id))[0].releaseId).toBe(v1.release.id);
    await db.agent.update({
      where: { id: sdk.id },
      data: {
        systemPrompt:
          "Unreviewed draft must not become applied during uninstall",
      },
    });
    const uninstallInput = {
      installId: installed.install.id,
      targetWorkspaceId: targetWorkspace,
      actorId: installer,
    };
    const [firstUninstall, secondUninstall, concurrentRollback] =
      await Promise.allSettled([
        removeMarketInstall(uninstallInput),
        removeMarketInstall(uninstallInput),
        rollbackAgentRevision(
          targetWorkspace,
          sdk.id,
          revision.id,
          revision.id,
        ),
      ]);
    expect(
      [firstUninstall, secondUninstall].some(
        (result) => result.status === "fulfilled",
      ),
    ).toBe(true);
    for (const result of [
      firstUninstall,
      secondUninstall,
      concurrentRollback,
    ]) {
      if (result.status === "rejected")
        expect(result.reason).toMatchObject({
          code: "AGENT_REVISION_CONFLICT",
        });
    }
    expect(await loaded(sdk.id)).toEqual([]);
    expect(
      await db.marketInstall.findUnique({
        where: { id: installed.install.id },
      }),
    ).toMatchObject({ status: "uninstalled" });
    const expectedVersion =
      revision.version +
      1 +
      (concurrentRollback.status === "fulfilled" ? 1 : 0);
    const emptyDefault = await db.agentRevision.findUniqueOrThrow({
      where: {
        agentId_version: { agentId: sdk.id, version: expectedVersion },
      },
    });
    expect(emptyDefault.config).toEqual({ ...revision.config, packages: [] });
    expect(await db.agentRevision.count({ where: { agentId: sdk.id } })).toBe(
      expectedVersion,
    );
    await expect(
      db.agent.findUniqueOrThrow({ where: { id: sdk.id } }),
    ).resolves.toMatchObject({
      currentRevisionVersion: emptyDefault.version,
      systemPrompt: "Unreviewed draft must not become applied during uninstall",
    });
    await expect(
      rollbackAgentRevision(targetWorkspace, sdk.id, revision.id, revision.id),
    ).rejects.toMatchObject({ code: "AGENT_REVISION_CONFLICT" });
    const newConversation = await db.conversation.create({
      data: {
        agentId: sdk.id,
        agentRevisionId: emptyDefault.id,
        legacyRevisionUnresolved: false,
      },
    });
    expect(
      (
        await resolvePiSessionPackages({
          workspaceId: targetWorkspace,
          agentId: sdk.id,
          conversationId: newConversation.id,
        })
      ).packages,
    ).toEqual([]);
    expect(
      (
        await resolvePiSessionPackages({
          workspaceId: targetWorkspace,
          agentId: sdk.id,
          conversationId: conversation.id,
        })
      ).packages[0].releaseId,
    ).toBe(v1.release.id);
    const restored = await rollbackAgentRevision(
      targetWorkspace,
      sdk.id,
      revision.id,
      emptyDefault.id,
    );
    expect(restored.id).not.toBe(revision.id);
    expect(restored.version).toBe(emptyDefault.version + 1);
    expect(restored.config.packages).toEqual([
      {
        marketInstallId: installed.install.id,
        releaseId: v1.release.id,
        integrity: v1.release.checksum,
      },
    ]);
    expect(await loaded(sdk.id)).toEqual([]);
    await revokeDangerousMarketRelease({
      workspaceId: sourceWorkspace,
      userId: publisher,
      releaseId: v1.release.id,
      reason: "Retained rollback fixture contains dangerous code",
    });
    await expect(
      rollbackAgentRevision(targetWorkspace, sdk.id, revision.id, restored.id),
    ).rejects.toMatchObject({ code: "listing_unavailable" });
    expect(
      await db.agent.findUniqueOrThrow({
        where: { id: sdk.id },
        select: { currentRevisionVersion: true },
      }),
    ).toMatchObject({ currentRevisionVersion: restored.version });
  });

  it("denies cross-workspace binding/update/uninstall and fails execution closed after revocation", async () => {
    const release = await publish();
    await approve(release);
    const installed = await install(release.release.id);
    const sdk = await agent();
    const other = await db.agent.create({
      data: {
        workspaceId: sourceWorkspace,
        name: "Other workspace",
        slug: `other-${++sequence}`,
        runtimeKind: "pi-sdk",
      },
    });
    await expect(
      bind(
        other.id,
        [
          {
            marketInstallId: installed.install.id,
            releaseId: release.release.id,
          },
        ],
        sourceWorkspace,
      ),
    ).rejects.toThrow("Unknown or inaccessible");
    await expect(
      updateMarketInstall({
        installId: installed.install.id,
        targetWorkspaceId: sourceWorkspace,
        actorId: publisher,
      }),
    ).rejects.toMatchObject({ code: "install_not_found" });
    await expect(
      removeMarketInstall({
        installId: installed.install.id,
        targetWorkspaceId: sourceWorkspace,
        actorId: publisher,
      }),
    ).rejects.toMatchObject({ code: "install_not_found" });
    await bind(sdk.id, [
      { marketInstallId: installed.install.id, releaseId: release.release.id },
    ]);
    await db.marketRelease.update({
      where: { id: release.release.id },
      data: { reviewStatus: "rejected" },
    });
    await expect(loaded(sdk.id)).rejects.toThrow("PI_PACKAGE_UNAVAILABLE");
    await expect(install(release.release.id)).rejects.toMatchObject({
      code: "listing_unavailable",
    });
  });

  it("rechecks capture-time permissions and rejects slug conflicts while superseding pending releases", async () => {
    const slug = `supersede-${++sequence}`;
    const first = await publish(slug);
    await expect(publish(slug)).rejects.toMatchObject({
      code: "listing_conflict",
    });
    const second = await publish(slug, first.listing.id);
    expect(
      (
        await db.marketRelease.findUniqueOrThrow({
          where: { id: first.release.id },
        })
      ).reviewStatus,
    ).toBe("rejected");
    expect(second.release.version).toBe(first.release.version + 1);
    expect(second.listing.pendingReleaseId).toBe(second.release.id);
    capture.mockImplementationOnce(async () => {
      await db.workspace.update({
        where: { id: sourceWorkspace },
        data: { ownerId: installer },
      });
      await db.membership.updateMany({
        where: { workspaceId: sourceWorkspace, userId: publisher },
        data: { role: "member" },
      });
      return snapshot();
    });
    const count = await db.marketRelease.count({
      where: { listing: { publisherWorkspaceId: sourceWorkspace } },
    });
    try {
      await expect(publish()).rejects.toMatchObject({ code: "not_authorized" });
    } finally {
      await db.workspace.update({
        where: { id: sourceWorkspace },
        data: { ownerId: publisher },
      });
      await db.membership.updateMany({
        where: { workspaceId: sourceWorkspace, userId: publisher },
        data: { role: "owner" },
      });
    }
    expect(
      await db.marketRelease.count({
        where: { listing: { publisherWorkspaceId: sourceWorkspace } },
      }),
    ).toBe(count);
  });

  it("rejects decoded secrets and tampered approved bytes without creating installs or changing an existing version", async () => {
    capture.mockResolvedValueOnce(
      snapshot("1.0.0", `export const token = "sk-proj-${"s".repeat(30)}";`),
    );
    await expect(publish()).rejects.toMatchObject({ code: "invalid_manifest" });
    const v1 = await publish();
    await approve(v1);
    const installed = await install(v1.release.id);
    const v2 = await publish(v1.listing.slug, v1.listing.id);
    await approve(v2);
    const corrupted = structuredClone(v2.manifest);
    const file = assertDefined(
      corrupted.package.entries.find((entry) => entry.type === "file"),
    );
    if (file.type === "file")
      file.content = Buffer.from("tampered").toString("base64");
    await db.marketRelease.update({
      where: { id: v2.release.id },
      data: {
        manifest: corrupted as Prisma.InputJsonValue,
        checksum: marketReleaseChecksum(corrupted),
      },
    });
    await expect(install(v2.release.id)).rejects.toMatchObject({
      code: "invalid_manifest",
    });
    await expect(
      updateMarketInstall({
        installId: installed.install.id,
        targetWorkspaceId: targetWorkspace,
        actorId: installer,
        targetReleaseId: v2.release.id,
      }),
    ).rejects.toMatchObject({ code: "invalid_manifest" });
    expect(
      (
        await db.marketInstall.findUniqueOrThrow({
          where: { id: installed.install.id },
        })
      ).currentReleaseId,
    ).toBe(v1.release.id);
  });
  it("leaves workspace version unchanged on a stale CAS or a downlisted release", async () => {
    const v1 = await publish();
    await approve(v1);
    const installed = await install(v1.release.id);
    const v2 = await publish(v1.listing.slug, v1.listing.id);
    await approve(v2);
    await expect(
      updateMarketInstall({
        installId: installed.install.id,
        targetWorkspaceId: targetWorkspace,
        actorId: installer,
        targetReleaseId: v2.release.id,
        currentReleaseId: "stale-release",
      }),
    ).rejects.toMatchObject({ code: "listing_conflict" });
    await db.marketListing.update({
      where: { id: v1.listing.id },
      data: { status: "disabled" },
    });
    await expect(
      updateMarketInstall({
        installId: installed.install.id,
        targetWorkspaceId: targetWorkspace,
        actorId: installer,
        targetReleaseId: v2.release.id,
      }),
    ).rejects.toMatchObject({ code: "listing_unavailable" });
    expect(
      (
        await db.marketInstall.findUniqueOrThrow({
          where: { id: installed.install.id },
        })
      ).requestedReleaseId,
    ).toBe(v1.release.id);
  });

  it("refuses approval when the submitted artifact checksum has changed", async () => {
    const pending = await publish();
    await db.marketRelease.update({
      where: { id: pending.release.id },
      data: { checksum: "0".repeat(64) },
    });
    await expect(approve(pending)).rejects.toMatchObject({
      code: "invalid_manifest",
    });
    expect(
      (
        await db.marketRelease.findUniqueOrThrow({
          where: { id: pending.release.id },
        })
      ).reviewStatus,
    ).toBe("pending");
  });

  it("rejects an incompatible frozen source at preview before publication", async () => {
    const incompatible = snapshot();
    incompatible.runtime.arch = arch === "arm64" ? "x64" : "arm64";
    capture.mockResolvedValueOnce(incompatible);
    await expect(publish()).rejects.toMatchObject({
      code: "package_platform_mismatch",
    });
  });
  it("requires a domain preview digest before capturing or publishing", async () => {
    await expect(
      publishPiPackageRelease({
        workspaceId: sourceWorkspace,
        publishedById: publisher,
        source: "npm:fixture-extension",
        categoryIds: [category],
        listing: { slug: `unpreviewed-${++sequence}`, name: "Unpreviewed" },
      }),
    ).rejects.toMatchObject({ code: "source_preview_required" });
    expect(capture).not.toHaveBeenCalled();
  });

  it("isolates selected private bytes in a new public listing and never exposes private history", async () => {
    const base = {
      workspaceId: sourceWorkspace,
      publishedById: publisher,
      source: "npm:fixture-extension",
      categoryIds: [category],
      sourceDigest: marketReleaseChecksum(snapshot()),
      confirmExecutableCode: true,
      visibility: "private" as const,
      listing: { slug: `private-${++sequence}`, name: "Private fixture" },
    };
    const privateRelease = await publishPiPackageRelease(base);
    await expect(
      publishPiPackageRelease({
        ...base,
        listingId: privateRelease.listing.id,
        visibility: "public",
      }),
    ).rejects.toMatchObject({ code: "listing_conflict" });
    const publicRelease = await publishPiPackageRelease({
      workspaceId: sourceWorkspace,
      publishedById: publisher,
      sourceType: "release",
      targetReleaseId: privateRelease.release.id,
      visibility: "public",
      categoryIds: [category],
      listing: { slug: `public-copy-${++sequence}`, name: "Approved bytes" },
    });
    expect(publicRelease.release.reviewStatus).toBe("pending");
    expect(publicRelease.manifest.package.entries).toEqual(
      privateRelease.manifest.package.entries,
    );
    expect(publicRelease.manifest.package.source.kind).toBe("zip");
    await approve(publicRelease);
    expect(
      await getMarketListing(
        privateRelease.listing.namespace,
        privateRelease.listing.slug,
      ),
    ).toBeNull();
    expect(
      await db.marketListing.findUniqueOrThrow({
        where: { id: privateRelease.listing.id },
      }),
    ).toMatchObject({ visibility: "private" });
  });

  it("applies only the reviewed package over the current revision, preserves drafts and existing sessions, and rejects stale review", async () => {
    const published = await publish();
    await approve(published);
    const installed = await install(published.release.id);
    const draftPackage = await publish();
    await approve(draftPackage);
    const draftInstall = await install(draftPackage.release.id);
    const sdk = await agent();
    const original = await publishFixtureAgentRevision(targetWorkspace, sdk.id);
    await bind(sdk.id, [
      {
        marketInstallId: draftInstall.install.id,
        releaseId: draftPackage.release.id,
      },
    ]);
    await db.agent.update({
      where: { id: sdk.id },
      data: { systemPrompt: "Unrelated unreviewed draft" },
    });
    const priorSession = await db.conversation.create({
      data: {
        agentId: sdk.id,
        agentRevisionId: original.id,
        legacyRevisionUnresolved: false,
      },
    });
    const input = {
      workspaceId: targetWorkspace,
      userId: installer,
      agentId: sdk.id,
      expectedRevisionId: original.id,
      package: {
        marketInstallId: installed.install.id,
        releaseId: published.release.id,
        integrity: published.release.checksum,
      },
      connections: [],
    };
    const applied = await applyPiPackageToAgent(input);
    expect(applied.config).toEqual({
      ...original.config,
      packages: [input.package],
    });
    expect(
      await db.agent.findUniqueOrThrow({ where: { id: sdk.id } }),
    ).toMatchObject({
      currentRevisionVersion: applied.version,
      systemPrompt: "Unrelated unreviewed draft",
    });
    expect(await db.agentPiPackage.count({ where: { agentId: sdk.id } })).toBe(
      2,
    );
    const nextSession = await db.conversation.create({
      data: {
        agentId: sdk.id,
        agentRevisionId: applied.id,
        legacyRevisionUnresolved: false,
      },
    });
    expect(
      (
        await resolvePiSessionPackages({
          workspaceId: targetWorkspace,
          agentId: sdk.id,
          conversationId: priorSession.id,
        })
      ).packages,
    ).toEqual([]);
    expect(
      (
        await resolvePiSessionPackages({
          workspaceId: targetWorkspace,
          agentId: sdk.id,
          conversationId: nextSession.id,
        })
      ).packages.map((entry) => entry.releaseId),
    ).toEqual([published.release.id]);
    await expect(applyPiPackageToAgent(input)).rejects.toMatchObject({
      code: "AGENT_REVISION_CONFLICT",
    });
    expect(await db.agentRevision.count({ where: { agentId: sdk.id } })).toBe(
      2,
    );
  });

  it("rolls back package bindings and the default when reviewed native publication fails", async () => {
    const published = await publish();
    await approve(published);
    const installed = await install(published.release.id);
    const sdk = await agent();
    const original = await publishFixtureAgentRevision(targetWorkspace, sdk.id);
    const input = {
      workspaceId: targetWorkspace,
      userId: installer,
      agentId: sdk.id,
      expectedRevisionId: original.id,
      package: {
        marketInstallId: installed.install.id,
        releaseId: published.release.id,
        integrity: published.release.checksum,
      },
      connections: [],
    };
    vi.mocked(preflightPiSdkCapabilities).mockRejectedValueOnce(
      new Error("Native capability collision"),
    );
    await expect(applyPiPackageToAgent(input)).rejects.toThrow(
      "Native capability collision",
    );
    expect(
      await db.agent.findUniqueOrThrow({ where: { id: sdk.id } }),
    ).toMatchObject({ currentRevisionVersion: original.version });
    expect(await db.agentRevision.count({ where: { agentId: sdk.id } })).toBe(
      1,
    );
    expect(await db.agentPiPackage.count({ where: { agentId: sdk.id } })).toBe(
      0,
    );
    const unpublished = await agent();
    await expect(
      applyPiPackageToAgent({ ...input, agentId: unpublished.id }),
    ).rejects.toMatchObject({ code: "AGENT_REVISION_UNRESOLVED" });
    expect(
      await db.agentPiPackage.count({ where: { agentId: unpublished.id } }),
    ).toBe(0);
    await removeMarketInstall({
      installId: installed.install.id,
      targetWorkspaceId: targetWorkspace,
      actorId: installer,
    });
    await expect(applyPiPackageToAgent(input)).rejects.toMatchObject({
      code: "PI_PACKAGE_UNAVAILABLE",
    });
    expect(await db.agentPiPackage.count({ where: { agentId: sdk.id } })).toBe(
      0,
    );
    expect(
      await db.agent.findUniqueOrThrow({ where: { id: sdk.id } }),
    ).toMatchObject({ currentRevisionVersion: original.version });
  });

  it("security revocation immediately denies pinned execution and retains readable references", async () => {
    const release = await publish();
    await approve(release);
    const installed = await install(release.release.id);
    await expect(
      revokeDangerousMarketRelease({
        workspaceId: targetWorkspace,
        userId: installer,
        releaseId: release.release.id,
        reason: "Dangerous code",
      }),
    ).rejects.toMatchObject({ code: "not_authorized" });
    await assertMarketReleasesExecutable(db, [release.release.id]);
    await revokeDangerousMarketRelease({
      workspaceId: sourceWorkspace,
      userId: publisher,
      releaseId: release.release.id,
      reason: "Dangerous code",
    });
    await expect(
      assertMarketReleasesExecutable(db, [release.release.id]),
    ).rejects.toMatchObject({ code: "listing_unavailable" });
    expect(
      await db.marketRelease.findUniqueOrThrow({
        where: { id: release.release.id },
      }),
    ).toMatchObject({ reviewStatus: "revoked" });
    expect(
      await db.marketInstall.findUniqueOrThrow({
        where: { id: installed.install.id },
      }),
    ).toMatchObject({ currentReleaseId: release.release.id });
    expect(
      await revokeDangerousMarketRelease({
        workspaceId: sourceWorkspace,
        userId: publisher,
        releaseId: release.release.id,
        reason: "Dangerous code",
      }),
    ).toMatchObject({ changed: false });
  });
});
