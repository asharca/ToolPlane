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
  publishAssembledPiPackageRelease,
  updatePiPackageMcpBindings,
  updateMarketInstall,
} from "@/lib/market/resources";
import {
  listWorkspaceMarketInstalls,
  removeMarketInstall,
} from "@/lib/market/skills";
import { updateAgent } from "@/lib/agents/mutations";
import { resolveAgentPiPackages } from "@/lib/agents/resolve";
import { marketReleaseChecksum } from "@/lib/market/artifact";
import type { PiPackageSnapshotV1 } from "@/lib/market/pi-package-manifest";
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
      nodeMajor: 24,
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
function publish(slug = `extension-${++sequence}`, listingId?: string) {
  return publishPiPackageRelease({
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
      }),
    ).rejects.toMatchObject({ code: "pi_package_source_unavailable" });
    const skillOnly = await publishAssembledPiPackageRelease({
      ...base,
      listing: { ...base.listing, slug: `skill-only-${++sequence}` },
      mcps: [],
    });
    expect(skillOnly.manifest.package.resources.extensions).toEqual([]);
    const v1 = await publishAssembledPiPackageRelease(base);
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
    const conversation = await db.conversation.create({
      data: { agentId: sdk.id },
    });
    const work = await db.workSession.create({
      data: {
        workspaceId: sourceWorkspace,
        agentId: sdk.id,
        conversationId: conversation.id,
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
    });
    await approve(v2);
    await updateMarketInstall({
      installId: installed.install.id,
      targetWorkspaceId: sourceWorkspace,
      actorId: publisher,
    });
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
    ).toEqual({ kind: "pi-package", mcpBindings: bindings });
  });

  it("keeps default-private imports out of public discovery, cross-workspace installs and artifact downloads", async () => {
    const pending = await publishPiPackageRelease({
      workspaceId: sourceWorkspace,
      publishedById: publisher,
      source: "npm:fixture-extension@latest",
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

  it("preserves Agent V1 through workspace V2 update, rejects first old-version bindings and busy apply, then explicitly applies V2", async () => {
    const v1 = await publish();
    await approve(v1);
    const installed = await install(v1.release.id);
    const sdk = await agent();
    const ordinary = await agent("pi");
    const binding = {
      marketInstallId: installed.install.id,
      releaseId: v1.release.id,
    };
    await bind(sdk.id, [binding]);
    await expect(bind(ordinary.id, [binding])).rejects.toThrow(
      "pi_packages_runtime_unsupported",
    );
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
    const fresh = await agent();
    await expect(bind(fresh.id, [binding])).rejects.toThrow(
      "pi_package_release_not_current",
    );
    const conversation = await db.conversation.create({
      data: { agentId: sdk.id },
    });
    const work = await db.workSession.create({
      data: {
        workspaceId: targetWorkspace,
        agentId: sdk.id,
        conversationId: conversation.id,
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
    await expect(
      removeMarketInstall({
        installId: installed.install.id,
        targetWorkspaceId: targetWorkspace,
        actorId: installer,
      }),
    ).rejects.toMatchObject({ code: "in_use" });
    await bind(sdk.id, []);
    await removeMarketInstall({
      installId: installed.install.id,
      targetWorkspaceId: targetWorkspace,
      actorId: installer,
    });
    expect(
      await db.marketInstall.findUnique({
        where: { id: installed.install.id },
      }),
    ).toBeNull();
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

  it("rejects a package captured for the other Docker architecture without a ready install", async () => {
    const incompatible = snapshot();
    incompatible.runtime.arch = arch === "arm64" ? "x64" : "arm64";
    capture.mockResolvedValueOnce(incompatible);
    const release = await publish();
    await approve(release);
    await expect(install(release.release.id)).rejects.toMatchObject({
      code: "package_platform_mismatch",
    });
    expect(
      await db.marketInstall.count({
        where: { listingId: release.listing.id },
      }),
    ).toBe(0);
  });
});
