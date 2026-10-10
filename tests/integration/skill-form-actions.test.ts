// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTranslator } from "next-intl";
import messages from "../../messages/en.json";
import { db } from "@/lib/db";
import {
  createCustomSkillAction,
  updateSkillContentAction,
  uploadSkillFolderAction,
} from "@/lib/skills/actions";
import {
  approveMarketRelease,
  installSkillRelease,
  publishSkillRelease,
} from "@/lib/market/skills";

const identity = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth/current-user", () => ({
  getCurrentUser: async () => ({ id: identity.id }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: "console.skills") =>
    createTranslator({ locale: "en", messages, namespace }),
}));

const stamp = `skill-forms-${process.pid}-${Date.now()}`;
let workspaceId = "";
let otherWorkspaceId = "";
let otherUserId = "";
let catalogId = "";
let readonlyId = "";
let foreignId = "";
let installedId = "";
let marketInstallId = "";
let listingId = "";
let categoryId = "";

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries({ workspace: stamp, ...values }))
    data.set(key, value);
  return data;
}

describe.sequential("skill form actions", () => {
  beforeAll(async () => {
    const user = await db.user.create({
      data: { email: `${stamp}@test.dev`, passwordHash: "x", role: "admin" },
    });
    identity.id = user.id;
    const other = await db.user.create({
      data: { email: `other-${stamp}@test.dev`, passwordHash: "x" },
    });
    otherUserId = other.id;
    const workspace = await db.workspace.create({
      data: {
        slug: stamp,
        name: stamp,
        ownerId: user.id,
        members: { create: { userId: user.id, role: "owner" } },
      },
    });
    workspaceId = workspace.id;
    const publisher = await db.workspace.create({
      data: {
        slug: `other-${stamp}`,
        name: "Publisher",
        ownerId: other.id,
        members: { create: { userId: other.id, role: "owner" } },
      },
    });
    otherWorkspaceId = publisher.id;
    const catalog = await db.skill.create({
      data: { slug: stamp, name: "Catalog", content: "# Catalog" },
    });
    catalogId = catalog.id;
    readonlyId = (
      await db.installedSkill.create({
        data: { workspaceId, skillId: catalogId },
      })
    ).id;
    const source = await db.installedSkill.create({
      data: {
        workspaceId: otherWorkspaceId,
        name: "Source",
        slug: stamp,
        source: "custom",
        content: "# Original",
        description: "Form integration fixture",
      },
    });
    foreignId = source.id;
    categoryId = (
      await db.category.create({ data: { slug: stamp, name: "Forms" } })
    ).id;
    const release = await publishSkillRelease({
      workspaceId: otherWorkspaceId,
      installedSkillId: source.id,
      publishedById: other.id,
      categoryIds: [categoryId],
    });
    listingId = release.listing.id;
    await approveMarketRelease({
      listingId,
      releaseId: release.release.id,
      reviewedById: user.id,
    });
    const installed = await installSkillRelease({
      releaseId: release.release.id,
      targetWorkspaceId: workspaceId,
      installedById: user.id,
      idempotencyKey: stamp,
    });
    installedId = installed.installedSkill.id;
    marketInstallId = installed.install.id;
  });

  afterAll(async () => {
    await db.workspace.deleteMany({
      where: { id: { in: [workspaceId, otherWorkspaceId] } },
    });
    await db.marketListing.deleteMany({ where: { id: listingId } });
    await db.skill.deleteMany({ where: { id: catalogId } });
    await db.category.deleteMany({ where: { id: categoryId } });
    await db.user.deleteMany({
      where: { id: { in: [identity.id, otherUserId] } },
    });
    await db.$disconnect();
  });

  it("denies cross-workspace and catalog edits without changing stored content", async () => {
    expect(
      await updateSkillContentAction(
        {},
        form({ installId: foreignId, content: "# Forbidden" }),
      ),
    ).toEqual({ error: "Resource not found or access denied." });
    expect(
      (await db.installedSkill.findUniqueOrThrow({ where: { id: foreignId } }))
        .content,
    ).toBe("# Original");
    expect(
      await updateSkillContentAction(
        {},
        form({ installId: readonlyId, content: "# Forbidden" }),
      ),
    ).toEqual({ error: "Resource not found or access denied." });
    expect(
      (await db.installedSkill.findUniqueOrThrow({ where: { id: readonlyId } }))
        .content,
    ).toBeNull();
    expect(
      (await db.skill.findUniqueOrThrow({ where: { id: catalogId } })).content,
    ).toBe("# Catalog");
  });

  it("persists editable content and marks its market installation modified", async () => {
    expect(
      await updateSkillContentAction(
        {},
        form({ installId: installedId, content: "# Draft\n\nnew text" }),
      ),
    ).toEqual({ saved: true });
    expect(
      (
        await db.installedSkill.findUniqueOrThrow({
          where: { id: installedId },
        })
      ).content,
    ).toBe("# Draft\n\nnew text");
    expect(
      (
        await db.marketInstall.findUniqueOrThrow({
          where: { id: marketInstallId },
        })
      ).status,
    ).toBe("modified");
  });

  it("rejects invalid creation and folder import without partial resources", async () => {
    const before = await db.installedSkill.count({ where: { workspaceId } });
    expect(
      await createCustomSkillAction({}, form({ name: "x".repeat(81) })),
    ).toEqual({ error: messages.console.skills.invalidCreateInput });
    expect(
      await uploadSkillFolderAction(
        {},
        form({
          files: JSON.stringify([
            { path: "one/SKILL.md", content: "# Good" },
            { path: "two/SKILL.md", content: "YmFk", encoding: "base64" },
          ]),
        }),
      ),
    ).toEqual({ error: messages.console.skills.invalidUpload });
    expect(await db.installedSkill.count({ where: { workspaceId } })).toBe(
      before,
    );
  });

  it("does not swallow successful creation and upload redirects", async () => {
    await expect(
      createCustomSkillAction(
        {},
        form({ name: "Created skill", description: "Fixture" }),
      ),
    ).rejects.toThrow(`REDIRECT:/app/${stamp}/skills/`);
    expect(
      await db.installedSkill.findFirst({
        where: { workspaceId, name: "Created skill" },
      }),
    ).toMatchObject({ source: "custom", description: "Fixture" });
    await expect(
      uploadSkillFolderAction(
        {},
        form({
          files: JSON.stringify([
            {
              path: "uploaded/SKILL.md",
              content:
                "---\nname: Uploaded skill\ndescription: Fixture\n---\n# Uploaded",
            },
          ]),
        }),
      ),
    ).rejects.toThrow(`REDIRECT:/app/${stamp}/skills?imported=`);
    expect(
      await db.installedSkill.findFirst({
        where: { workspaceId, name: "Uploaded skill" },
      }),
    ).toMatchObject({ source: "upload" });
  });
});
