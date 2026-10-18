// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applySystemUpdate,
  getSystemUpdateStatus,
  parseChecksum,
  readCurrentVersion,
} from "@/lib/system/release-update";
import type { SystemUpdateJobStatus } from "@/lib/system/release-update";

const globals = globalThis as typeof globalThis & {
  __toolplaneSystemUpdateJob?: SystemUpdateJobStatus;
};
let root: string;
const fetchMock = vi.fn();
const artifact = "toolplane-runtime-linux-amd64.tar.gz";

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "release-boundaries-"));
  delete globals.__toolplaneSystemUpdateJob;
  vi.stubEnv("TOOLPLANE_RUNTIME_ROOT", root);
  vi.stubEnv("TOOLPLANE_UPDATE_ENABLED", "true");
  vi.stubEnv("TOOLPLANE_UPDATE_REPO", "acme/runtime");
  vi.stubEnv("TOOLPLANE_UPDATE_ARTIFACT", "");
  vi.stubEnv("TOOLPLANE_UPDATE_TAG", "");
  vi.stubEnv("TOOLPLANE_VERSION", "v1");
  vi.stubEnv("TOOLPLANE_GITHUB_TOKEN", "");
  vi.stubEnv("GITHUB_TOKEN", "");
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => {
  delete globals.__toolplaneSystemUpdateJob;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

describe("release metadata boundaries", () => {
  it("prefers a trimmed release version to environment and handles absent package versions", async () => {
    await writeFile(path.join(root, ".toolplane-version"), "  v-file\n");
    expect(await readCurrentVersion(root)).toBe("v-file");
    await writeFile(path.join(root, ".toolplane-version"), " \n ");
    expect(await readCurrentVersion(root)).toBe("v1");
    vi.stubEnv("TOOLPLANE_VERSION", "");
    for (const value of [{}, { version: 2 }, { version: "  " }]) {
      await writeFile(path.join(root, "package.json"), JSON.stringify(value));
      expect(await readCurrentVersion(root)).toBe("unknown");
    }
    await writeFile(path.join(root, "package.json"), "not-json");
    expect(await readCurrentVersion(root)).toBe("unknown");
  });
  it("ignores mismatched checksum records and normalizes valid uppercase hashes", () => {
    expect(
      parseChecksum(
        `\n${"F".repeat(64)} other.tar.gz\nbad ${artifact}\n${"A".repeat(64)} nested/${artifact}\n`,
        artifact,
      ),
    ).toBe("a".repeat(64));
    expect(parseChecksum("a".repeat(64), artifact)).toBeNull();
  });
  it.each([false, true])(
    "reports unavailable versions when release metadata has no matching artifact (%s)",
    async (assets) => {
      fetchMock.mockImplementation(async () =>
        Response.json({ tag_name: "v2", ...(assets ? { assets: [] } : {}) }),
      );
      expect(await getSystemUpdateStatus()).toMatchObject({
        canUpdate: false,
        latestVersion: "v2",
        releaseName: "v2",
        updateAvailable: null,
        reason: `Release artifact not found: ${artifact}`,
      });
      expect(await applySystemUpdate()).toMatchObject({
        ok: false,
        status: "unavailable",
        latestVersion: "v2",
        message: `Release artifact not found: ${artifact}`,
      });
    },
  );
  it.each(["v1", "v2", ""])(
    "calculates update availability for release %s",
    async (tag) => {
      fetchMock.mockResolvedValue(
        Response.json({
          tag_name: tag,
          name: "Named release",
          html_url: "https://github.com/acme/runtime/releases",
          assets: [{ name: artifact }],
        }),
      );
      expect(await getSystemUpdateStatus()).toMatchObject({
        canUpdate: true,
        latestVersion: tag || null,
        updateAvailable: tag ? tag !== "v1" : null,
        releaseName: "Named release",
        releaseUrl: "https://github.com/acme/runtime/releases",
      });
    },
  );
  it("looks up an encoded explicit tag using the configured token", async () => {
    vi.stubEnv("TOOLPLANE_UPDATE_TAG", "release/one");
    vi.stubEnv("TOOLPLANE_GITHUB_TOKEN", "release-secret");
    fetchMock.mockResolvedValue(Response.json({ tag_name: "v1" }));
    expect(await applySystemUpdate()).toMatchObject({
      ok: true,
      status: "up_to_date",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/runtime/releases/tags/release%2Fone",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer release-secret",
        }),
        cache: "no-store",
      }),
    );
  });
  it("requires a checksum before starting a background update", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        tag_name: "v2",
        assets: [
          {
            name: artifact,
            browser_download_url: "https://github.com/artifact",
          },
        ],
      }),
    );
    expect(await applySystemUpdate()).toMatchObject({
      ok: false,
      status: "unavailable",
      message: `Release checksum not found: ${artifact}.sha256`,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([new Error("lookup offline"), "lookup failure"])(
    "exposes lookup failures as status instead of throwing",
    async (error) => {
      fetchMock.mockRejectedValue(error);
      expect(await getSystemUpdateStatus()).toMatchObject({
        canUpdate: false,
        reason: error instanceof Error ? error.message : error,
      });
      expect(await applySystemUpdate()).toMatchObject({
        ok: false,
        status: "failed",
        message: error instanceof Error ? error.message : error,
      });
    },
  );
  it("bounds failed GitHub response details", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response("x".repeat(1000), {
          status: 403,
          statusText: "Forbidden",
        }),
    );
    const status = await getSystemUpdateStatus();
    expect(status.reason).toBe(
      `GitHub release lookup failed: 403 Forbidden ${"x".repeat(300)}`,
    );
  });
  it.each(["disabled", "unconfigured", "unwritable"])(
    "does not fetch releases when runtime is %s",
    async (state) => {
      if (state === "disabled") vi.stubEnv("TOOLPLANE_UPDATE_ENABLED", "false");
      if (state === "unconfigured") vi.stubEnv("TOOLPLANE_RUNTIME_ROOT", "");
      if (state === "unwritable")
        vi.stubEnv("TOOLPLANE_RUNTIME_ROOT", path.join(root, "missing"));
      expect(await getSystemUpdateStatus()).toMatchObject({ canUpdate: false });
      expect(await applySystemUpdate()).toMatchObject({
        ok: false,
        status: state === "disabled" ? "disabled" : "unavailable",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it.each(["downloading", "applying", "restarting"] as const)(
    "deduplicates requests while the job is %s",
    async (status) => {
      globals.__toolplaneSystemUpdateJob = {
        status,
        targetVersion: "v2",
        message: null,
        startedAt: null,
        updatedAt: "now",
      };
      expect(await applySystemUpdate()).toMatchObject({
        ok: true,
        status: status === "restarting" ? "restarting" : "updating",
        latestVersion: "v2",
        message: "An update is already in progress.",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it("honors another update which started during release lookup", async () => {
    fetchMock.mockImplementation(async () => {
      globals.__toolplaneSystemUpdateJob = {
        status: "restarting",
        targetVersion: "v3",
        message: "Restart pending",
        startedAt: null,
        updatedAt: "now",
      };
      return Response.json({
        tag_name: "v2",
        assets: [{ name: artifact }, { name: `${artifact}.sha256` }],
      });
    });
    expect(await applySystemUpdate()).toMatchObject({
      ok: true,
      status: "restarting",
      latestVersion: "v3",
      message: "Restart pending",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
