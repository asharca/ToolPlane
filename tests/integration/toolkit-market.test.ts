// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { cutoverToolkitToPrivatePackage } from "@/lib/toolkits/cutover";
import { createApiToken, verifyApiTokenContext } from "@/lib/auth/tokens";
import { parsePiPackageReleaseManifest } from "@/lib/market/pi-package-manifest";
import { toolkitAccessWhere } from "@/lib/auth/toolkit-scope";

const stamp = `${process.pid}-${Date.now()}`;
let workspaceId = "",
  ownerId = "",
  memberId = "",
  outsiderId = "",
  toolkitId = "",
  skillId = "";
let sequence = 0;
describe.sequential("controlled Toolkit private-package cutover", () => {
  beforeAll(async () => {
    const users = await Promise.all(
      ["owner", "member", "outsider"].map((role) =>
        db.user.create({
          data: {
            email: `cutover-${role}-${stamp}@test.dev`,
            passwordHash: "x",
          },
        }),
      ),
    );
    [ownerId, memberId, outsiderId] = users.map((user) => user.id);
    const workspace = await db.workspace.create({
      data: {
        slug: `cutover-${stamp}`,
        name: "Private source",
        ownerId,
        members: {
          create: [
            { userId: ownerId, role: "owner" },
            { userId: memberId, role: "member" },
          ],
        },
      },
    });
    workspaceId = workspace.id;
    const skill = await db.installedSkill.create({
      data: {
        workspaceId,
        name: "Review",
        slug: "review",
        source: "custom",
        content:
          "---\nname: review\ndescription: Review changes\n---\nReview the change.",
        files: [
          {
            path: "assets/nested.bin",
            content: Buffer.from([0, 255, 7, 128]).toString("base64"),
            encoding: "base64",
          },
        ],
      },
    });
    skillId = skill.id;
    toolkitId = (
      await db.toolkit.create({
        data: {
          workspaceId,
          name: "Private historical toolkit",
          slug: "historical",
          visibility: "public",
          skills: { create: { installedSkillId: skillId } },
        },
      })
    ).id;
  });
  afterAll(async () => {
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
    await db.workspace.deleteMany({ where: { id: workspaceId } });
    await db.user.deleteMany({
      where: { id: { in: [ownerId, memberId, outsiderId] } },
    });
    await db.$disconnect();
  });
  it("rejects ordinary members, foreign users, and cross-workspace source IDs", async () => {
    for (const userId of [memberId, outsiderId])
      await expect(
        cutoverToolkitToPrivatePackage({
          workspaceId,
          userId,
          toolkitId,
          mode: "dry-run",
        }),
      ).rejects.toMatchObject({ code: "not_authorized" });
    await expect(
      cutoverToolkitToPrivatePackage({
        workspaceId,
        userId: ownerId,
        toolkitId: "foreign",
        mode: "dry-run",
      }),
    ).rejects.toMatchObject({ code: "source_not_found" });
  });
  it("dry-runs exact bytes without mutations and blocks apply until every legacy task drains", async () => {
    const agent = await db.agent.create({
      data: {
        workspaceId,
        slug: `legacy-${++sequence}`,
        name: "Legacy",
        runtimeKind: "hermes",
        toolkits: { create: { toolkitId } },
      },
    });
    const conversation = await db.conversation.create({
      data: { agentId: agent.id, title: "Historical task" },
    });
    const task = await db.workSession.create({
      data: {
        workspaceId,
        agentId: agent.id,
        conversationId: conversation.id,
        runtimeKind: "hermes",
        status: "running",
      },
    });
    const preview = await cutoverToolkitToPrivatePackage({
      workspaceId,
      userId: ownerId,
      toolkitId,
      mode: "dry-run",
    });
    expect(preview).toMatchObject({
      status: "blocked",
      blockers: ["active_legacy_tasks"],
      requiresReauthorization: true,
    });
    expect(
      await db.marketListing.count({ where: { sourceToolkitId: toolkitId } }),
    ).toBe(0);
    expect(
      await db.toolkit.findUniqueOrThrow({ where: { id: toolkitId } }),
    ).toMatchObject({ enabled: true });
    await expect(
      cutoverToolkitToPrivatePackage({
        workspaceId,
        userId: ownerId,
        toolkitId,
        mode: "apply",
        expectedDigest: preview.digest ?? "",
        confirmReauthorization: true,
      }),
    ).rejects.toMatchObject({ code: "in_use" });
    await db.workSession.update({
      where: { id: task.id },
      data: { status: "completed", completedAt: new Date() },
    });
  });
  it("rejects stale preview then freezes a PRIVATE artifact, revokes tokens, preserves history, and applies idempotently", async () => {
    const scoped = await createApiToken(ownerId, "Historical scoped key", {
      toolkitId,
    });
    await db.toolkitInstallLink.create({
      data: { id: `legacy-link-${stamp}`, userId: ownerId, toolkitId },
    });
    const legacy = await createApiToken(
      ownerId,
      "MCPmarket plugin - historical (Claude Code)",
    );
    const unrelated = await createApiToken(ownerId, "Unrelated personal key");
    const preview = await cutoverToolkitToPrivatePackage({
      workspaceId,
      userId: ownerId,
      toolkitId,
      mode: "dry-run",
    });
    expect(preview.status).toBe("ready");
    await db.installedSkill.update({
      where: { id: skillId },
      data: {
        content:
          "---\nname: review\ndescription: Review changes\n---\nChanged since preview.",
      },
    });
    await expect(
      cutoverToolkitToPrivatePackage({
        workspaceId,
        userId: ownerId,
        toolkitId,
        mode: "apply",
        expectedDigest: preview.digest ?? "",
        confirmReauthorization: true,
      }),
    ).rejects.toMatchObject({ code: "source_changed" });
    const current = await cutoverToolkitToPrivatePackage({
      workspaceId,
      userId: ownerId,
      toolkitId,
      mode: "dry-run",
    });
    const result = await cutoverToolkitToPrivatePackage({
      workspaceId,
      userId: ownerId,
      toolkitId,
      mode: "apply",
      expectedDigest: current.digest ?? "",
      confirmReauthorization: true,
    });
    expect(result.status).toBe("applied");
    if (!("releaseId" in result) || !result.releaseId)
      throw new Error("Missing frozen release");
    const release = await db.marketRelease.findUniqueOrThrow({
      where: { id: result.releaseId },
      include: { listing: true },
    });
    expect(release.listing).toMatchObject({
      kind: "pi-package",
      visibility: "private",
      sourceToolkitId: toolkitId,
    });
    const manifest = parsePiPackageReleaseManifest(
      release.manifest,
      release.checksum,
    );
    expect(
      manifest.package.entries.some(
        (entry) =>
          entry.type === "file" &&
          entry.path.endsWith("/assets/nested.bin") &&
          Buffer.from(entry.content, "base64").equals(
            Buffer.from([0, 255, 7, 128]),
          ),
      ),
    ).toBe(true);
    expect(JSON.stringify(manifest)).not.toContain(workspaceId);
    expect(JSON.stringify(manifest)).not.toContain(toolkitId);
    expect(await verifyApiTokenContext(`Bearer ${scoped.token}`)).toBeNull();
    expect(await verifyApiTokenContext(`Bearer ${legacy.token}`)).toBeNull();
    expect(
      await verifyApiTokenContext(`Bearer ${unrelated.token}`),
    ).not.toBeNull();
    expect(
      await db.toolkit.findUniqueOrThrow({ where: { id: toolkitId } }),
    ).toMatchObject({ enabled: false, visibility: "private" });
    expect(
      await db.toolkit.findFirst({
        where: toolkitAccessWhere(
          { user: { id: ownerId }, token: null },
          `cutover-${stamp}`,
          "historical",
        ),
      }),
    ).toBeNull();
    expect(await db.workSession.count({ where: { workspaceId } })).toBe(1);
    expect(
      await db.agentPiPackage.count({
        where: { marketInstall: { listingId: release.listingId } },
      }),
    ).toBe(0);
    expect(
      await cutoverToolkitToPrivatePackage({
        workspaceId,
        userId: ownerId,
        toolkitId,
        mode: "apply",
        expectedDigest: current.digest ?? "",
        confirmReauthorization: true,
      }),
    ).toMatchObject({ status: "already-applied", releaseId: release.id });
    expect(
      await db.auditEvent.count({
        where: {
          action: "toolkit.cutover.private-freeze",
          targetId: toolkitId,
        },
      }),
    ).toBe(1);
  });
});
