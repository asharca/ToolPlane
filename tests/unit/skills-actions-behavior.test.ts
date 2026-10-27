// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertDefined } from "../assert-defined";

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  workspace: vi.fn(),
  find: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  market: vi.fn(),
  modify: vi.fn(),
  transaction: vi.fn(),
  revalidate: vi.fn(),
  redirect: vi.fn(),
}));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/workspace/queries", () => ({
  getWorkspaceForUser: mocks.workspace,
}));
vi.mock("@/lib/admin/settings", () => ({
  getSkillImportSettings: async () => ({ maxSkills: 80 }),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/db", () => ({
  db: {
    installedSkill: {
      findFirst: mocks.find,
      findMany: mocks.list,
      create: mocks.create,
      update: mocks.update,
      deleteMany: mocks.remove,
    },
    marketInstall: { findFirst: mocks.market, updateMany: mocks.modify },
    $transaction: mocks.transaction,
  },
}));

import {
  createCustomSkillAction,
  deleteCustomSkillAction,
  importSkillFromGithubAction,
  updateSkillAttributesAction,
  updateSkillContentAction,
  uploadSkillFolderAction,
  previewSkillUploadAction,
} from "@/lib/skills/actions";

import { writeZip } from "@/lib/archives/zip";
function form(values: Record<string, string> = {}) {
  const data = new FormData();
  for (const [key, value] of Object.entries({
    workspace: "team",
    installId: "skill",
    ...values,
  }))
    data.set(key, value);
  return data;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue({ id: "user" });
  mocks.workspace.mockResolvedValue({ id: "workspace" });
  mocks.find.mockResolvedValue({ id: "skill" });
  mocks.list.mockResolvedValue([]);
  mocks.create.mockResolvedValue({ id: "created" });
  mocks.transaction.mockImplementation(async (operation) =>
    typeof operation === "function"
      ? operation({
          installedSkill: { update: mocks.update },
          marketInstall: { updateMany: mocks.modify },
        })
      : Promise.all(operation),
  );
  mocks.redirect.mockImplementation((url) => {
    throw new Error(`REDIRECT:${url}`);
  });
});

describe("custom skill authorization and editing", () => {
  it.each(["user", "workspace"] as const)(
    "rejects all mutations when %s is absent",
    async (missing) => {
      mocks[missing].mockResolvedValue(null);
      expect(
        await createCustomSkillAction({}, form({ name: "Skill" })),
      ).toEqual({ error: "formAccessDenied" });
      expect(await updateSkillContentAction({}, form())).toEqual({
        error: "formAccessDenied",
      });
      expect(await uploadSkillFolderAction({}, form())).toEqual({
        error: "formAccessDenied",
      });
      expect(await importSkillFromGithubAction({}, form())).toEqual({
        error: "formAccessDenied",
      });
      await updateSkillAttributesAction(form());
      await deleteCustomSkillAction(form());
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.update).not.toHaveBeenCalled();
      expect(mocks.remove).not.toHaveBeenCalled();
    },
  );
  it("rejects editing catalog skills or skills belonging to other workspaces", async () => {
    mocks.find.mockResolvedValue(null);
    expect(await updateSkillContentAction({}, form())).toEqual({
      error: "formAccessDenied",
    });
    await updateSkillAttributesAction(form());
    await deleteCustomSkillAction(form());
    expect(mocks.find).toHaveBeenCalledWith({
      where: { id: "skill", workspaceId: "workspace", skillId: null },
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("publishes edited content and marks market installs modified atomically", async () => {
    expect(
      await updateSkillContentAction({}, form({ content: "# Updated" })),
    ).toEqual({ saved: true });
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "skill" },
      data: { content: "# Updated", status: "published" },
    });
    expect(mocks.modify).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "modified" } }),
    );
    expect(mocks.revalidate).toHaveBeenCalledWith("/app/team/skills/skill");
    mocks.transaction.mockRejectedValueOnce(new Error("transaction failed"));
    expect(await updateSkillContentAction({}, form())).toEqual({
      error: "formSaveFailed",
    });
  });
  it("preserves market-managed skills but deletes an unlinked custom skill", async () => {
    mocks.market.mockResolvedValueOnce({ id: "install" });
    await deleteCustomSkillAction(form());
    expect(mocks.remove).not.toHaveBeenCalled();
    await expect(deleteCustomSkillAction(form())).rejects.toThrow(
      "REDIRECT:/app/team/skills",
    );
    expect(mocks.remove).toHaveBeenCalledWith({
      where: { id: "skill", workspaceId: "workspace" },
    });
  });
});

describe("skill upload parsing", () => {
  it.each(["not json", "{}", "[]", '[{"path":null,"content":null}]'])(
    "rejects invalid legacy upload payload %s",
    async (files) => {
      expect(await uploadSkillFolderAction({}, form({ files }))).toEqual({
        error: "invalidUpload",
      });
      expect(mocks.create).not.toHaveBeenCalled();
    },
  );
  it("imports multipart text and binary files, honoring explicit relative paths and name", async () => {
    const data = form({
      name: "Personal Skill",
      filePaths: JSON.stringify(["bundle/SKILL.md", "bundle/icon.png"]),
    });
    data.set("archive", new File([], ""));
    data.append(
      "folderFiles",
      new File(
        [
          "---\nname: Original\ndescription: A useful skill\n---\n# Instructions",
        ],
        "SKILL.md",
        { type: "text/markdown" },
      ),
    );
    data.append(
      "folderFiles",
      new File([new Uint8Array([0, 255, 1])], "icon.png", {
        type: "image/png",
      }),
    );
    await expect(uploadSkillFolderAction({}, data)).rejects.toThrow(
      "REDIRECT:/app/team/skills?imported=created",
    );
    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: "Personal Skill",
        slug: "personal-skill",
        source: "upload",
        sourceRef: "bundle",
        description: "A useful skill",
        files: [{ path: "icon.png", content: "AP8B", encoding: "base64" }],
      }),
    });
  });
  it.each(["not-json", "{}", "[null]"])(
    "falls back to uploaded filenames with malformed paths %s",
    async (filePaths) => {
      const data = form({ filePaths });
      data.append(
        "folderFiles",
        new File(["# My skill"], "SKILL.md", { type: "text/markdown" }),
      );
      await expect(uploadSkillFolderAction({}, data)).rejects.toThrow(
        "REDIRECT:/app/team/skills?imported=created",
      );
      expect(mocks.create).toHaveBeenCalledOnce();
    },
  );
  it("reserves unique slugs across existing catalog skills and imported siblings", async () => {
    mocks.list.mockResolvedValue([
      { slug: null, skill: { slug: "same" } },
      { slug: "same-2", skill: null },
      { slug: null, skill: null },
    ]);
    const data = form({
      files: JSON.stringify([
        { path: "one/SKILL.md", content: "---\nname: Same\n---\n# One" },
        { path: "two/SKILL.md", content: "---\nname: Same\n---\n# Two" },
      ]),
    });
    await expect(uploadSkillFolderAction({}, data)).rejects.toThrow(
      "REDIRECT:",
    );
    expect(mocks.create.mock.calls.map((call) => call[0].data.slug)).toEqual([
      "same-3",
      "same-4",
    ]);
  });
  it("reports save failure after successful parsing without revalidating", async () => {
    mocks.transaction.mockRejectedValueOnce(new Error("save failed"));
    expect(
      await uploadSkillFolderAction(
        {},
        form({
          files: JSON.stringify([{ path: "SKILL.md", content: "# Skill" }]),
        }),
      ),
    ).toEqual({ error: "formSaveFailed" });
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
  it("rejects non-GitHub sources before requesting bundles", async () => {
    expect(
      await importSkillFromGithubAction(
        {},
        form({ repo: "https://attacker.example/skill" }),
      ),
    ).toEqual({ error: "invalidUpload" });
  });
  it("binds ZIP root selection to previewed archive bytes and rejects empty explicit selection", async () => {
    const files = [
      { path: "first/SKILL.md", data: Buffer.from("# First") },
      { path: "second/SKILL.md", data: Buffer.from("# Second") },
    ];
    const data = form();
    data.set(
      "archive",
      new File([new Uint8Array(writeZip(files))], "skills.zip"),
    );
    data.append("folderFiles", new File([], ""));
    const preview = await previewSkillUploadAction({}, data);
    const sourceDigest = assertDefined(preview.sourceDigest);
    expect(preview.preview?.map((root) => root.rootPath)).toEqual([
      "first",
      "second",
    ]);
    expect(mocks.create).not.toHaveBeenCalled();
    data.set("sourceDigest", sourceDigest);
    data.set("selectionMode", "explicit");
    expect(await uploadSkillFolderAction({}, data)).toEqual({
      error: "importSelectRoots",
    });
    data.append("roots", "second");
    const changed = form();
    changed.set(
      "archive",
      new File(
        [
          new Uint8Array(
            writeZip([
              { ...files[0], data: Buffer.from("# Changed") },
              files[1],
            ]),
          ),
        ],
        "skills.zip",
      ),
    );
    changed.set("sourceDigest", sourceDigest);
    changed.set("selectionMode", "explicit");
    changed.append("roots", "second");
    expect(await uploadSkillFolderAction({}, changed)).toEqual({
      error: "importSourceChanged",
    });
    await expect(uploadSkillFolderAction({}, data)).rejects.toThrow(
      "REDIRECT:",
    );
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0][0].data.sourceRef).toBe("second");
  });
  it("distinguishes selecting ZIP root from no selected roots", async () => {
    const data = form({
      files: JSON.stringify([{ path: "SKILL.md", content: "# Root" }]),
    });
    const preview = await previewSkillUploadAction({}, data);
    const sourceDigest = assertDefined(preview.sourceDigest);
    expect(preview.preview?.[0].rootPath).toBeNull();
    data.set("sourceDigest", sourceDigest);
    data.set("selectionMode", "explicit");
    data.append("roots", "");
    await expect(uploadSkillFolderAction({}, data)).rejects.toThrow(
      "REDIRECT:",
    );
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
});
