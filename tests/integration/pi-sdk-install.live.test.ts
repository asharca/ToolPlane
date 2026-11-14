// @vitest-environment node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// SANDBOX_DOCKER_SMOKE=1 pnpm vitest run tests/integration/pi-sdk-install.live.test.ts
const run = process.env.SANDBOX_DOCKER_SMOKE === "1";
const execute = promisify(execFile);

(run ? describe : describe.skip)("offline Pi SDK installation", () => {
  it("preserves SDK bytes and rejects truncated archives and changed installed files", async () => {
    const source = await readFile("scripts/pi-sdk-install.mjs", "utf8");
    const scenario = String.raw`
await (async () => {
  const assert = await import("node:assert/strict");
  const fs = await import("node:fs/promises");
  const { createReadStream, createWriteStream } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const directory = "/workspace/.toolplane/runtime-packages/pi-sdk-1.5.2";
  const archive = "/tmp/sdk.archive";
  const damaged = "/tmp/damaged.archive";
  const checksum = async (path) => {
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(path)) hash.update(bytes);
    return hash.digest("hex");
  };
  await writePiSdkArchive("/opt/pi-sdk", "sha256:" + "a".repeat(64), createWriteStream(archive));
  const sha256 = await checksum(archive);
  await fs.copyFile(archive, damaged);
  await fs.truncate(damaged, (await fs.stat(damaged)).size - 1);
  // A correct transport digest must not hide a body shorter than its manifest.
  await assert.rejects(
    installPiSdkRuntime({ directory, sha256: await checksum(damaged) }, createReadStream(damaged)),
    /PI_SDK_ARTIFACT_TRUNCATED/,
  );
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
  await assert.rejects(
    installPiSdkRuntime({ directory, sha256 }, createReadStream(damaged)),
    /PI_SDK_ARTIFACT_DIGEST_MISMATCH/,
  );
  await installPiSdkRuntime({ directory, sha256 }, createReadStream(archive));
  assert.equal(await verifyPiSdkRuntime(directory), true);
  const sdk = await import(directory + "/node_modules/@earendil-works/pi-coding-agent/dist/index.js");
  assert.equal(typeof sdk.createAgentSessionRuntime, "function");
  // Revalidation compares real installed bytes, not just a marker or version.
  const entry = directory + "/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
  await fs.appendFile(entry, "\n// changed after installation\n");
  await assert.rejects(
    installPiSdkRuntime({ directory, sha256 }, (await import("node:stream")).Readable.from([])),
    /PI_SDK_INTEGRITY_MISMATCH/,
  );
  console.log("SDK_INSTALL_BOUNDARIES_OK");
})();
`;
    const result = execute(
      "docker",
      [
        "run",
        "--rm",
        "--pull",
        "never",
        "--network",
        "none",
        "--read-only",
        "--user",
        "1000:1000",
        "-i",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=512m",
        "--tmpfs",
        "/workspace:rw,exec,nosuid,nodev,uid=1000,gid=1000,size=512m",
        "--entrypoint",
        "node",
        "toolplane-pi-package-capture:1.5.2",
        "--input-type=module",
        "-",
      ],
      { timeout: 180_000, maxBuffer: 1024 * 1024 },
    );
    result.child.stdin?.end(`${source}\n${scenario}`);
    expect((await result).stdout.trim()).toBe("SDK_INSTALL_BOUNDARIES_OK");
  }, 190_000);
});
