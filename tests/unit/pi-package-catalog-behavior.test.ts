// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as PiNetwork from "@/lib/market/pi-package-network";
const mocks = vi.hoisted(() => ({
  workspace: vi.fn(),
  many: vi.fn(),
  find: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  request: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => {
  const db = {
    workspace: { findFirst: mocks.workspace },
    piPackageSource: {
      findMany: mocks.many,
      findFirst: mocks.find,
      create: mocks.create,
      update: mocks.update,
      deleteMany: mocks.remove,
    },
    $transaction: async (run: (tx: unknown) => unknown) => run(db),
  };
  return { db };
});
vi.mock("@/lib/market/skills", () => ({
  MarketError: class extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock("@/lib/security/secrets", () => ({
  encryptSecretText: mocks.encrypt,
  decryptSecretText: mocks.decrypt,
}));
vi.mock("@/lib/market/pi-package-source", () => ({
  validatePiPackageSource: vi.fn(),
}));
vi.mock("@/lib/market/pi-package-network", async (original) => ({
  ...(await original<typeof PiNetwork>()),
  piSourceRequest: mocks.request,
}));
import {
  createPiPackageSource,
  deletePiPackageSource,
  listOfficialPiPackages,
  listPiPackageSourceEntries,
  listPiPackageSources,
  resolvePiPackageCaptureSource,
  updatePiPackageSource,
} from "@/lib/market/pi-package-catalog";
const access = { workspaceId: "w", userId: "u" };
const source = {
  id: "s",
  name: "Private packages",
  kind: "npm",
  url: "https://registry.example.com/",
  credentialsEnc: null,
  updatedAt: new Date("2026-01-01"),
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.workspace.mockResolvedValue({ id: "w" });
  mocks.find.mockResolvedValue(source);
  mocks.create.mockResolvedValue({ id: "new" });
  mocks.update.mockResolvedValue({ id: "s" });
  mocks.encrypt.mockImplementation((value) => ({ encrypted: value }));
});

describe("private package source management", () => {
  it("never exposes encrypted credentials when listing sources", async () => {
    mocks.many.mockResolvedValue([
      { ...source, credentialsEnc: "secret" },
      source,
    ]);
    const result = await listPiPackageSources(access);
    expect(result.map((row) => row.hasCredentials)).toEqual([true, false]);
    expect(result.every((row) => !("credentialsEnc" in row))).toBe(true);
  });
  it("normalizes npm scope and encrypts credentials before persistence", async () => {
    expect(
      await createPiPackageSource({
        ...access,
        name: "  Team  ",
        kind: "npm",
        url: "https://registry.example.com/team",
        credentials: { type: "bearer", token: "private-token" },
      }),
    ).toEqual({ id: "new", hasCredentials: true });
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          workspaceId: "w",
          name: "Team",
          kind: "npm",
          url: "https://registry.example.com/team/",
          credentialsEnc: JSON.stringify({
            encrypted: JSON.stringify({
              type: "bearer",
              token: "private-token",
            }),
          }),
        },
      }),
    );
    expect(mocks.workspace).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            {
              members: {
                some: { userId: "u", role: { in: ["owner", "admin"] } },
              },
            },
          ]),
        }),
      }),
    );
  });
  it.each([
    { name: "", url: "https://registry.example.com/", code: "source_invalid" },
    {
      name: "Team",
      url: "http://registry.example.com/",
      code: "source_invalid",
    },
  ])("rejects invalid source input", async ({ name, url, code }) => {
    await expect(
      createPiPackageSource({ ...access, name, kind: "npm", url }),
    ).rejects.toMatchObject({ code });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("rejects malformed credentials without storing secrets", async () => {
    await expect(
      createPiPackageSource({
        ...access,
        name: "Team",
        kind: "npm",
        url: source.url,
        credentials: { type: "bearer", token: "line\nbreak" },
      }),
    ).rejects.toMatchObject({ code: "source_credentials_invalid" });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("requires new credential consent when changing a secret-bearing scope", async () => {
    mocks.find.mockResolvedValue({ ...source, credentialsEnc: "encrypted" });
    await expect(
      updatePiPackageSource({
        ...access,
        sourceId: "s",
        url: "https://other.example.com/",
      }),
    ).rejects.toMatchObject({ code: "source_credentials_required" });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(
      await updatePiPackageSource({
        ...access,
        sourceId: "s",
        url: "https://other.example.com/",
        credentials: null,
        name: " Renamed ",
      }),
    ).toEqual({ id: "s", hasCredentials: false });
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          name: "Renamed",
          url: "https://other.example.com/",
          credentialsEnc: null,
        },
      }),
    );
  });
  it("retains same-scope credentials and rejects missing sources or empty names", async () => {
    mocks.find.mockResolvedValue({ ...source, credentialsEnc: "encrypted" });
    expect(await updatePiPackageSource({ ...access, sourceId: "s" })).toEqual({
      id: "s",
      hasCredentials: true,
    });
    await expect(
      updatePiPackageSource({ ...access, sourceId: "s", name: " " }),
    ).rejects.toMatchObject({ code: "source_invalid" });
    mocks.find.mockResolvedValue(null);
    await expect(
      updatePiPackageSource({ ...access, sourceId: "s" }),
    ).rejects.toMatchObject({ code: "source_not_found" });
  });
  it("scopes deletion and reports missing sources", async () => {
    mocks.remove
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    await expect(
      deletePiPackageSource({ ...access, sourceId: "s" }),
    ).rejects.toMatchObject({ code: "source_not_found" });
    await expect(
      deletePiPackageSource({ ...access, sourceId: "s" }),
    ).resolves.toBeUndefined();
    expect(mocks.remove).toHaveBeenLastCalledWith({
      where: { id: "s", workspaceId: "w" },
    });
  });
  it("denies source access before reading catalog or source data", async () => {
    mocks.workspace.mockResolvedValue(null);
    await expect(listPiPackageSources(access)).rejects.toMatchObject({
      code: "not_authorized",
    });
    await expect(
      resolvePiPackageCaptureSource({ ...access, source: "npm:pkg" }),
    ).rejects.toMatchObject({ code: "not_authorized" });
    expect(mocks.many).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });
});

describe("package capture scopes and catalog browsing", () => {
  it("uses default public capture and keeps catalog credentials out of capture", async () => {
    expect(
      await resolvePiPackageCaptureSource({ ...access, source: "npm:pkg" }),
    ).toEqual({});
    mocks.find.mockResolvedValue({
      ...source,
      kind: "catalog",
      credentialsEnc: "invalid",
    });
    expect(
      await resolvePiPackageCaptureSource({
        ...access,
        sourceId: "s",
        source: "npm:pkg",
      }),
    ).toEqual({ sourceId: "s", sourceUpdatedAt: source.updatedAt });
    expect(mocks.decrypt).not.toHaveBeenCalled();
  });
  it.each([
    [{ type: "bearer", token: "token" }, "Bearer token"],
    [
      { type: "basic", username: "user", password: "pass" },
      "Basic dXNlcjpwYXNz",
    ],
  ])(
    "decrypts authentication only for its configured npm scope",
    async (credentials, authorization) => {
      mocks.find.mockResolvedValue({
        ...source,
        credentialsEnc: JSON.stringify({ encrypted: "value" }),
      });
      mocks.decrypt.mockReturnValue(JSON.stringify(credentials));
      expect(
        await resolvePiPackageCaptureSource({
          ...access,
          sourceId: "s",
          source: "npm:pkg",
        }),
      ).toEqual({
        sourceId: "s",
        sourceUpdatedAt: source.updatedAt,
        registry: source.url,
        authentication: { url: source.url, authorization },
      });
    },
  );
  it("rejects corrupt credentials, mismatched kinds and mismatched git repositories", async () => {
    mocks.find.mockResolvedValueOnce({ ...source, credentialsEnc: "invalid" });
    await expect(
      resolvePiPackageCaptureSource({
        ...access,
        sourceId: "s",
        source: "npm:pkg",
      }),
    ).rejects.toMatchObject({ code: "source_credentials_invalid" });
    await expect(
      resolvePiPackageCaptureSource({
        ...access,
        sourceId: "s",
        source: "git:https://github.com/org/repo",
      }),
    ).rejects.toMatchObject({ code: "source_kind_mismatch" });
    mocks.find.mockResolvedValue({
      ...source,
      kind: "git",
      url: "https://github.com/org/repo",
    });
    await expect(
      resolvePiPackageCaptureSource({
        ...access,
        sourceId: "s",
        source: "git:https://github.com/other/repo",
      }),
    ).rejects.toMatchObject({ code: "source_scope_mismatch" });
    expect(
      await resolvePiPackageCaptureSource({
        ...access,
        sourceId: "s",
        source: "git:github.com/org/repo@main",
      }),
    ).toEqual({ sourceId: "s", sourceUpdatedAt: source.updatedAt });
  });
  it("filters git entries locally and never fetches a remote catalog", async () => {
    mocks.find.mockResolvedValue({ ...source, kind: "git" });
    expect(
      (
        await listPiPackageSourceEntries({
          ...access,
          sourceId: "s",
          query: "PRIVATE",
        })
      ).entries,
    ).toEqual([
      { name: source.name, source: source.url, description: "", version: null },
    ]);
    expect(
      (
        await listPiPackageSourceEntries({
          ...access,
          sourceId: "s",
          query: "missing",
        })
      ).entries,
    ).toEqual([]);
    expect(
      (await listPiPackageSourceEntries({ ...access, sourceId: "s", page: 2 }))
        .entries,
    ).toEqual([]);
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("converts npm search results and preserves pagination", async () => {
    mocks.request.mockResolvedValue(
      Buffer.from(
        JSON.stringify({
          objects: [{ package: { name: "@team/pkg", version: "1.0.0" } }],
          total: 101,
        }),
      ),
    );
    expect(
      await listPiPackageSourceEntries({
        ...access,
        sourceId: "s",
        query: " agent ",
        page: 2,
      }),
    ).toEqual({
      entries: [
        {
          name: "@team/pkg",
          source: "npm:@team/pkg",
          version: "1.0.0",
          description: "",
        },
      ],
      page: 2,
      hasMore: true,
    });
    const url = mocks.request.mock.calls[0][0] as URL;
    expect(url.searchParams.get("text")).toBe("keywords:pi-package agent");
    expect(url.searchParams.get("from")).toBe("50");
  });
  it("parses strict catalogs, applies defaults, and rejects malformed responses", async () => {
    mocks.find.mockResolvedValue({ ...source, kind: "catalog" });
    mocks.request.mockResolvedValueOnce(
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          entries: [{ name: "Pkg", source: "npm:pkg" }],
          hasMore: false,
        }),
      ),
    );
    expect(
      await listPiPackageSourceEntries({ ...access, sourceId: "s" }),
    ).toEqual({
      entries: [
        { name: "Pkg", source: "npm:pkg", description: "", version: null },
      ],
      page: 1,
      hasMore: false,
    });
    for (const bytes of [
      Buffer.from("not json"),
      Buffer.from([0xff]),
      Buffer.from('{"schemaVersion":2}'),
    ]) {
      mocks.request.mockResolvedValueOnce(bytes);
      await expect(
        listPiPackageSourceEntries({ ...access, sourceId: "s" }),
      ).rejects.toMatchObject({ code: "source_response_invalid" });
    }
  });
  it.each([0, 1.5, 1001, Number.NaN])(
    "rejects unsafe page %s before network requests",
    async (page) => {
      await expect(
        listPiPackageSourceEntries({ ...access, sourceId: "s", page }),
      ).rejects.toMatchObject({ code: "source_invalid" });
      expect(mocks.request).not.toHaveBeenCalled();
    },
  );
  it("decodes official server-rendered entries without running scripts", async () => {
    mocks.request.mockResolvedValue(
      Buffer.from(
        '<article data-package-card="true" data-package-name="pkg"><p class="packages-desc">A &amp; B &#65; &#x42;</p><a href="?package-version=1.2.3%2Bbuild"></a></article><span class="packages-count">1-50 / 75</span>',
      ),
    );
    expect(await listOfficialPiPackages({ query: " pkg " })).toEqual({
      entries: [
        {
          name: "pkg",
          source: "npm:pkg",
          description: "A & B A B",
          version: "1.2.3+build",
        },
      ],
      page: 1,
      hasMore: true,
    });
    expect(
      (mocks.request.mock.calls[0][0] as URL).searchParams.get("name"),
    ).toBe("pkg");
  });
  it.each([
    '<span class="packages-count">1 / 1</span>',
    '<article data-package-card="true"></article><span class="packages-count">1 / 1</span>',
    '<article data-package-card="true" data-package-name="pkg"><a href="?package-version=%ZZ"></a></article><span class="packages-count">1 / 1</span>',
    "unrecognized html",
  ])("rejects incomplete official catalog HTML", async (html) => {
    mocks.request.mockResolvedValue(Buffer.from(html));
    await expect(listOfficialPiPackages()).rejects.toMatchObject({
      code: "source_response_invalid",
    });
  });
  it("accepts a genuinely empty official catalog", async () => {
    mocks.request.mockResolvedValue(
      Buffer.from('<span class="packages-count">0 / 0</span>'),
    );
    expect(await listOfficialPiPackages()).toEqual({
      entries: [],
      page: 1,
      hasMore: false,
    });
  });
});
