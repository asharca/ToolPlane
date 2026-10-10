// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getAgentForRun } from "@/lib/agents/queries";
import { resolveAgentPiPackages } from "@/lib/agents/resolve";
import { runAgentTurn } from "@/lib/agents/run";
import { updateAgent } from "@/lib/agents/mutations";
import {
  assertWorkPiPackageSnapshot,
  createWorkSession,
} from "@/lib/work/sessions";
import { marketReleaseChecksum } from "@/lib/market/artifact";
import type { PiPackageManifestV1 } from "@/lib/market/pi-package-manifest";

const stamp = randomUUID();
let workspaceId = "",
  userId = "",
  providerId = "";
let sequence = 0;

function manifest(name: string, version: number): PiPackageManifestV1 {
  const bytes = Buffer.from(
    `export default function(pi) { pi.registerCommand("Version", { handler: async () => pi.sendMessage({ customType: "version", content: "${version}", display: true }) }); }`,
  );
  return {
    schemaVersion: 1,
    kind: "pi-package",
    listing: {
      slug: name,
      name,
      summary: null,
      iconUrl: null,
      tags: [],
      author: "Fixture",
    },
    package: {
      source: {
        kind: "npm",
        requested: `npm:${name}@${version}.0.0`,
        name,
        version: `${version}.0.0`,
        integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
      },
      name,
      version: `${version}.0.0`,
      root: "package",
      runtime: {
        kind: "pi-sdk",
        piVersion: "0.87.1",
        nodeMajor: 24,
        platform: "linux",
        arch: "arm64",
      },
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
          content: bytes.toString("base64"),
          executable: false,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      ],
    },
  };
}

async function fixture() {
  const slug = `resource-${++sequence}`;
  const deployment = await db.deployment.create({
    data: { workspaceId, source: "config" },
  });
  const sandbox = await db.sandbox.create({
    data: {
      workspaceId,
      deploymentId: deployment.id,
      name: slug,
      slug,
      kind: "docker",
      network: "isolated",
    },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: slug,
      slug,
      runtimeKind: "pi-sdk",
      providerId,
      model: "fixture",
      sandboxes: { create: { sandboxId: sandbox.id, isDefault: true } },
    },
  });
  const packages = [];
  for (const suffix of ["z", "a"]) {
    const name = `${slug}-${suffix}`;
    const listing = await db.marketListing.create({
      data: {
        kind: "pi-package",
        namespace: `sdk-resources-${stamp}`,
        slug: name,
        name,
        publisherWorkspaceId: workspaceId,
        status: "published",
        metadata: {},
      },
    });
    const releases = [];
    for (const version of [1, 2]) {
      const artifact = manifest(name, version);
      releases.push(
        await db.marketRelease.create({
          data: {
            listingId: listing.id,
            version,
            reviewStatus: "approved",
            manifest: artifact as Prisma.InputJsonValue,
            checksum: marketReleaseChecksum(artifact),
            releaseSummary: {},
          },
        }),
      );
    }
    const install = await db.marketInstall.create({
      data: {
        id: `${stamp}-${slug}-${suffix}`,
        listingId: listing.id,
        targetWorkspaceId: workspaceId,
        currentReleaseId: releases[0].id,
        requestedReleaseId: releases[0].id,
        status: "ready",
        idempotencyKey: name,
        resourceMap: { kind: "pi-package" },
      },
    });
    await db.agentPiPackage.create({
      data: {
        agentId: agent.id,
        marketInstallId: install.id,
        releaseId: releases[0].id,
      },
    });
    packages.push({ listing, install, v1: releases[0], v2: releases[1] });
  }
  return { agent, sandbox, packages };
}

async function enabled(agentId: string) {
  const agent = await getAgentForRun(agentId, workspaceId);
  if (!agent) throw new Error("Missing fixture Agent");
  return resolveAgentPiPackages(agent);
}

beforeAll(async () => {
  userId = (
    await db.user.create({
      data: { email: `sdk-resources-${stamp}@test.invalid`, passwordHash: "x" },
    })
  ).id;
  workspaceId = (
    await db.workspace.create({
      data: {
        ownerId: userId,
        slug: `sdk-resources-${stamp}`,
        name: "SDK resources",
      },
    })
  ).id;
  providerId = (
    await db.modelProvider.create({
      data: {
        workspaceId,
        name: "Fixture",
        format: "openai",
        baseUrl: "https://model.test.invalid",
        apiKey: "fixture-only",
        models: ["fixture"],
      },
    })
  ).id;
});
afterAll(async () => {
  if (workspaceId) {
    await db.agent.deleteMany({ where: { workspaceId } });
    await db.marketInstall.deleteMany({
      where: { targetWorkspaceId: workspaceId },
    });
    await db.marketListing.deleteMany({
      where: { publisherWorkspaceId: workspaceId },
    });
    await db.workspace.delete({ where: { id: workspaceId } });
  }
  if (userId) await db.user.delete({ where: { id: userId } });
});

describe.sequential("Pi SDK resource consumers", () => {
  it("pins sorted Work identities across workspace upgrades and requires a new Work after applying them", async () => {
    const { agent, sandbox, packages } = await fixture();
    const work = await createWorkSession({
      workspaceId,
      agentId: agent.id,
      sandboxId: sandbox.id,
      task: "Inspect the reviewed package",
    });
    if (!work) throw new Error("Work was not created");
    const original = packages
      .map(({ install, v1 }) => ({
        marketInstallId: install.id,
        releaseId: v1.id,
        checksum: v1.checksum,
      }))
      .sort((a, b) => a.marketInstallId.localeCompare(b.marketInstallId));
    expect(work.runtimeSnapshot).toMatchObject({ piPackages: original });
    expect(JSON.stringify(work.runtimeSnapshot)).not.toContain(
      "contentEncoding",
    );
    const upgraded = packages[0];
    await db.marketInstall.update({
      where: { id: upgraded.install.id },
      data: {
        currentReleaseId: upgraded.v2.id,
        requestedReleaseId: upgraded.v2.id,
      },
    });
    assertWorkPiPackageSnapshot(
      "pi-sdk",
      work.runtimeSnapshot,
      await enabled(agent.id),
    );
    expect(
      (await enabled(agent.id)).map(
        ({ marketInstallId, releaseId, checksum }) => ({
          marketInstallId,
          releaseId,
          checksum,
        }),
      ),
    ).toEqual(original);

    await db.workSession.update({
      where: { id: work.id },
      data: { status: "idle" },
    });
    await updateAgent(workspaceId, agent.id, {
      name: agent.name,
      systemPrompt: null,
      providerId,
      model: "fixture",
      maxSteps: agent.maxSteps,
      piPackages: packages.map(({ install, v1 }) => ({
        marketInstallId: install.id,
        releaseId: install.id === upgraded.install.id ? upgraded.v2.id : v1.id,
      })),
    });
    const current = await enabled(agent.id);
    expect(() =>
      assertWorkPiPackageSnapshot("pi-sdk", work.runtimeSnapshot, current),
    ).toThrow("PI_SDK_PACKAGE_SET_CHANGED");
    const next = await createWorkSession({
      workspaceId,
      agentId: agent.id,
      task: "Use the explicitly enabled version",
    });
    expect(next?.runtimeSnapshot).toMatchObject({
      piPackages: current.map(({ marketInstallId, releaseId, checksum }) => ({
        marketInstallId,
        releaseId,
        checksum,
      })),
    });
    expect(
      (await db.workSession.findUniqueOrThrow({ where: { id: work.id } }))
        .runtimeSnapshot,
    ).toEqual(work.runtimeSnapshot);
  });

  it.each(["release-revoked", "listing-disabled", "bytes-tampered"] as const)(
    "revalidates fresh Work and sub-agent resources after %s",
    async (change) => {
      const { agent, packages } = await fixture();
      const selected = packages[0];
      expect(
        (await enabled(agent.id)).find(
          (item) => item.marketInstallId === selected.install.id,
        )?.releaseId,
      ).toBe(selected.v1.id);
      if (change === "release-revoked")
        await db.marketRelease.update({
          where: { id: selected.v1.id },
          data: { reviewStatus: "rejected" },
        });
      if (change === "listing-disabled")
        await db.marketListing.update({
          where: { id: selected.listing.id },
          data: { status: "disabled" },
        });
      if (change === "bytes-tampered")
        await db.marketRelease.update({
          where: { id: selected.v1.id },
          data: {
            manifest: manifest(
              selected.listing.slug,
              3,
            ) as Prisma.InputJsonValue,
          },
        });
      await expect(
        createWorkSession({
          workspaceId,
          agentId: agent.id,
          task: "Must not execute",
        }),
      ).rejects.toThrow("PI_PACKAGE_UNAVAILABLE");
      await expect(
        runAgentTurn(agent.id, "Must not execute", {
          workspaceId,
          depth: 1,
          visited: new Set(["parent-agent"]),
        }),
      ).resolves.toContain("PI_PACKAGE_UNAVAILABLE");
      expect(await db.workSession.count({ where: { agentId: agent.id } })).toBe(
        0,
      );
    },
  );

  it("does not silently continue an old Work after removing its packages, while a fresh package-free Work is valid", async () => {
    const { agent } = await fixture();
    const work = await createWorkSession({
      workspaceId,
      agentId: agent.id,
      task: "Original resources",
    });
    if (!work) throw new Error("Work was not created");
    await db.workSession.update({
      where: { id: work.id },
      data: { status: "idle" },
    });
    await updateAgent(workspaceId, agent.id, {
      name: agent.name,
      systemPrompt: null,
      providerId,
      model: "fixture",
      maxSteps: agent.maxSteps,
      piPackages: [],
    });
    const current = await enabled(agent.id);
    expect(() =>
      assertWorkPiPackageSnapshot("pi-sdk", work.runtimeSnapshot, current),
    ).toThrow("PI_SDK_PACKAGE_SET_CHANGED");
    expect(() => assertWorkPiPackageSnapshot("pi-sdk", {}, current)).toThrow(
      "PI_SDK_PACKAGE_SET_CHANGED",
    );
    const next = await createWorkSession({
      workspaceId,
      agentId: agent.id,
      task: "No extensions",
    });
    expect(next?.runtimeSnapshot).toMatchObject({ piPackages: [] });
    assertWorkPiPackageSnapshot("pi-sdk", next?.runtimeSnapshot, current);
  });
});
