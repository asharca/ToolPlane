// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  currentUser: vi.fn(),
  findUnique: vi.fn(),
  save: vi.fn(),
}));
vi.mock("@/lib/auth/current-user", () => ({
  getCurrentUser: state.currentUser,
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock("@/lib/db", () => ({
  db: { systemSetting: { findUnique: state.findUnique } },
}));
vi.mock("@/lib/admin/audited-setting", () => ({
  saveAuditedSetting: state.save,
}));

import { getTransportSettings } from "@/lib/admin/transport-settings";
import { updateTransportSettingsAction } from "@/lib/admin/transport-settings-actions";

function form(allowHttp = "true", limit = "512", intent = "save") {
  const data = new FormData();
  data.set("allowHttp", allowHttp);
  data.set("a2aInlineKiB", limit);
  data.set("intent", intent);
  data.set("a2aFileMiB", "10");
  data.set("a2aTaskInputMiB", "100");
  data.set("a2aTaskFiles", "20");
  data.set("a2aWorkspaceFileGiB", "1");
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.currentUser.mockResolvedValue({ id: "admin", role: "admin" });
});

describe("administrator transport security boundaries", () => {
  it.each([null, { id: "member", role: "user" }])(
    "denies save and reset by a non-administrator (%s)",
    async (user) => {
      state.currentUser.mockResolvedValue(user);
      for (const intent of ["save", "reset"]) {
        await expect(
          updateTransportSettingsAction({}, form("true", "512", intent)),
        ).rejects.toThrow("redirect:");
      }
      expect(state.save).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["on", "512"],
    ["TRUE", "512"],
    ["", "512"],
    ["true", "0"],
    ["true", "10241"],
    ["true", "1.5"],
    ["true", "1e3"],
    ["true", ""],
    ["true", "Infinity"],
  ])(
    "rejects malformed policy without changing active settings (%s, %s)",
    async (allowHttp, limit) => {
      expect(
        await updateTransportSettingsAction({}, form(allowHttp, limit)),
      ).toHaveProperty("error");
      expect(state.save).not.toHaveBeenCalled();
    },
  );
  it.each([
    ...["0", "101", "1.5", "1e2", "", "Infinity"].map((value) => [
      "a2aFileMiB",
      value,
    ]),
    ["a2aTaskInputMiB", "0"],
    ["a2aTaskInputMiB", "10241"],
    ["a2aTaskFiles", "0"],
    ["a2aTaskFiles", "101"],
    ["a2aWorkspaceFileGiB", "0"],
    ["a2aWorkspaceFileGiB", "1025"],
  ])(
    "rejects an invalid file limit without changing settings (%s=%s)",
    async (field, value) => {
      const data = form();
      data.set(field, value);
      expect(await updateTransportSettingsAction({}, data)).toHaveProperty(
        "error",
      );
      expect(state.save).not.toHaveBeenCalled();
    },
  );

  it("saves administrator file limits in bytes", async () => {
    const data = form();
    data.set("a2aTaskInputMiB", "512");
    data.set("a2aTaskFiles", "50");
    data.set("a2aWorkspaceFileGiB", "8");
    expect(await updateTransportSettingsAction({}, data)).toEqual({ ok: true });
    expect(JSON.parse(state.save.mock.calls[0][1])).toMatchObject({
      a2aFileBytes: 10 * 1024 ** 2,
      a2aTaskInputBytes: 512 * 1024 ** 2,
      a2aTaskFiles: 50,
      a2aWorkspaceFileBytes: 8 * 1024 ** 3,
    });
  });

  it("keeps existing HTTP and inline settings when upgrading a policy without a file limit", async () => {
    state.findUnique.mockResolvedValue({
      value: JSON.stringify({ allowHttp: true, a2aInlineBytes: 524288 }),
    });
    expect(await getTransportSettings()).toEqual({
      allowHttp: true,
      a2aInlineBytes: 524288,
      a2aFileBytes: 10 * 1024 * 1024,
      a2aTaskInputBytes: 100 * 1024 * 1024,
      a2aTaskFiles: 20,
      a2aWorkspaceFileBytes: 1024 * 1024 * 1024,
      source: "database",
    });
  });

  it.each([1, 25, 100])(
    "reads an administrator file limit of %s MiB",
    async (mib) => {
      state.findUnique.mockResolvedValue({
        value: JSON.stringify({
          allowHttp: false,
          a2aInlineBytes: 32768,
          a2aFileBytes: mib * 1024 * 1024,
        }),
      });
      expect((await getTransportSettings()).a2aFileBytes).toBe(
        mib * 1024 * 1024,
      );
    },
  );

  it.each([
    "{",
    "null",
    '{"allowHttp":"true","a2aInlineBytes":524288}',
    '{"allowHttp":true,"a2aInlineBytes":0}',
    '{"allowHttp":true,"a2aInlineBytes":10485761}',
    '{"allowHttp":true,"a2aInlineBytes":32768,"a2aFileBytes":104857601}',
    '{"allowHttp":true,"a2aInlineBytes":32768,"a2aFileBytes":"26214400"}',
    '{"allowHttp":true,"a2aInlineBytes":32768,"a2aTaskFiles":0}',
    '{"allowHttp":true,"a2aInlineBytes":32768,"a2aTaskInputBytes":1.5}',
  ])(
    "never enables plaintext from invalid persisted policy (%s)",
    async (value) => {
      state.findUnique.mockResolvedValue({ value });
      expect((await getTransportSettings()).allowHttp).toBe(false);
    },
  );
});
