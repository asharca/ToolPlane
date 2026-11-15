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
  it("distributes debugpy independently and hits a Python breakpoint, reads variables, resumes and cleans up", async () => {
    const exporter = await readFile("scripts/pi-debugpy-export.mjs", "utf8");
    const extension = await readFile("scripts/pi-optional-tools/debug.mjs", "utf8");
    const scenario = String.raw`
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
const root = await fs.mkdtemp("/tmp/toolplane-debug-");
await fs.writeFile(root + "/debug.mjs", Buffer.from(EXTENSION, "base64"));
const artifact = await exportDebugpy();
await fs.writeFile(root + "/debugpy.artifact.json", JSON.stringify(artifact));
const { default: register } = await import(root + "/debug.mjs");
let tool;
const hooks = new Map();
register({ registerTool: value => { tool = value; }, on: (name, handler) => hooks.set(name, handler) });
const call = async (args, signal) => (await tool.execute("debug-real", args, signal, undefined, { cwd: root })).details;
const program = root + "/program.py";
await fs.writeFile(program, "value = 40\nvalue += 2\nprint(value, flush=True)\n");
try {
  assert.equal((await call({ action: "launch", program, language: "python" })).state, "stopped");
  await assert.rejects(call({ action: "launch", program, language: "python" }), /DEBUG_SESSION_ACTIVE/);
  await call({ action: "set_breakpoints", file: program, lines: [3] });
  assert.equal((await call({ action: "continue" })).state, "stopped");
  const stack = await call({ action: "stack" });
  assert.equal(stack.stackFrames[0].line, 3);
  const scopes = await call({ action: "scopes" });
  const locals = scopes.scopes.find(scope => scope.name === "Locals");
  assert.ok(locals);
  const variables = await call({ action: "variables", variables_reference: locals.variablesReference });
  assert.equal(variables.variables.find(value => value.name === "value").value, "42");
  assert.equal((await call({ action: "evaluate", expr: "value" })).result, "42");
  const completed = await call({ action: "continue" });
  assert.equal(completed.state, "terminated");
  assert.match(completed.output, /42/);
  // A second launch reuses the verified independent artifact, not the SDK tree.
  const loop = root + "/loop.py";
  await fs.writeFile(loop, "import time\nwhile True:\n    time.sleep(0.01)\n");
  await call({ action: "launch", program: loop, language: "python" });
  const pid = Number((await call({ action: "evaluate", expr: "__import__('os').getpid()" })).result);
  const controller = new AbortController();
  const running = call({ action: "continue" }, controller.signal);
  // This child-process integration intentionally uses the real platform clock:
  // fake timers in Vitest cannot drive adapter subprocesses or kernel reaping.
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(running, /DEBUG_ABORTED/);
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch { break; }
    await delay(20);
  }
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await call({ action: "launch", program: loop, language: "python" });
  await assert.rejects(call({ action: "continue", timeout_ms: 1000 }), /DEBUG_TIMEOUT/);
  await call({ action: "launch", program: loop, language: "python" });
  const finalPid = Number((await call({ action: "evaluate", expr: "__import__('os').getpid()" })).result);
  hooks.get("agent_end")();
  for (let i = 0; i < 100; i++) {
    try { process.kill(finalPid, 0); } catch { break; }
    await delay(20);
  }
  assert.throws(() => process.kill(finalPid, 0), { code: "ESRCH" });
  await assert.rejects(call({ action: "stack" }), /DEBUG_SESSION_MISSING/);
  await fs.appendFile(root + "/.toolplane-tools/debug/" + artifact.sha256 + "/debugpy/__init__.py", "\n# tampered\n");
  await assert.rejects(call({ action: "launch", program, language: "python" }), /DEBUG_DEPENDENCY_MISSING/);
  console.log("DEBUG_OFFLINE_LIFECYCLE_OK");
} finally {
  hooks.get("session_shutdown")();
  await fs.rm(root, { recursive: true, force: true });
}
`;
    const result = execute("docker", [
      "run", "--rm", "--init", "--pull", "never", "--network", "none", "--read-only",
      "--user", "1000:1000", "-i", "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=512m",
      "--entrypoint", "node", "toolplane-pi-package-capture:1.5.2", "--input-type=module", "-",
    ], { timeout: 120_000, maxBuffer: 1024 * 1024 });
    result.child.stdin?.end(`${exporter}\nconst EXTENSION = ${JSON.stringify(Buffer.from(extension).toString("base64"))};\n${scenario}`);
    expect((await result).stdout.trim()).toBe("DEBUG_OFFLINE_LIFECYCLE_OK");
  }, 130_000);
});
