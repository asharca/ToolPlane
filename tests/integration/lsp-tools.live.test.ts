// @vitest-environment node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { LSP_TOOLS_IMAGE } from "@/lib/agents/lsp-runtime";

// Build target lsp-tools with TOOLPLANE_LSP_TOOLS_IMAGE or its published default tag.
const run = process.env.SANDBOX_DOCKER_SMOKE === "1";
const execute = promisify(execFile);

(run ? describe : describe.skip)("offline native LSP tool", () => {
  it("installs a digest-authenticated independent artifact and queries real TS and Python servers", async () => {
    const installer = await readFile("scripts/lsp-tools-install.mjs", "utf8");
    const extension = await readFile(
      "scripts/pi-optional-tools/lsp.mjs",
      "utf8",
    );
    const scenario = String.raw`
// This subprocess intentionally exercises SDK module loading in the offline image.
await (async () => {
const assert = await import('node:assert/strict');
const fs = await import('node:fs/promises');
const { createReadStream, createWriteStream } = await import('node:fs');
const { createHash } = await import('node:crypto');
const archive = '/tmp/lsp.archive';
await exportLspArtifact(createWriteStream(archive));
const hash = createHash('sha256');
for await (const bytes of createReadStream(archive)) hash.update(bytes);
const digest = hash.digest('hex');
assert.equal(await verifyLspArtifact(digest), false);
const directory = await installLspArtifact(digest, createReadStream(archive));
assert.equal(directory, '/workspace/.toolplane-tools/lsp/' + digest);
assert.equal(await verifyLspArtifact(digest), true);
// Reuse is idempotent, consumes the transport, and does not change the SDK tree.
assert.equal(await installLspArtifact(digest, createReadStream(archive)), directory);
await assert.rejects(fs.stat('/workspace/.toolplane/runtime-packages'), { code: 'ENOENT' });
await assert.rejects(installLspArtifact('f'.repeat(64), createReadStream(archive)), /LSP_ARTIFACT_INVALID/);
const cwd = '/workspace/session';
const sharedDir = '/workspace/shared';
await fs.mkdir(cwd);
await fs.mkdir(sharedDir);
// The process starts in the image's /opt/toolplane-lsp, not the session cwd.
assert.notEqual(process.cwd(), cwd);
await fs.writeFile(cwd + '/tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['*.ts'] }));
await fs.writeFile(cwd + '/sample.ts', 'export function greet(value: number) { return value; }\nconst broken: string = greet(1);\nconst found = greet(2);\n');
await fs.writeFile(cwd + '/sample.py', 'value: int = "oops"\n');
globalThis[Symbol.for('toolplane.pi.host-context.v1')] = { kind: 'toolplane-sdk', platformMcp: true, lsp: { packageRoot: directory, sharedDir, cwd } };
const { loadExtensions } = await import('/opt/pi-sdk/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js');
const loaded = await loadExtensions(['/tmp/optional-lsp.mjs'], cwd);
assert.deepEqual(loaded.errors, []);
const native = loaded.extensions[0];
const { ExtensionRunner } = await import('/opt/pi-sdk/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js');
const { wrapRegisteredTool } = await import('/opt/pi-sdk/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/wrapper.js');
const { SessionManager } = await import('/opt/pi-sdk/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js');
const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, SessionManager.inMemory(cwd), undefined);
const tool = wrapRegisteredTool(native.tools.get('lsp'), runner);
// SDK wrappers allow caller contexts to override runner context. The trusted
// host cwd must still win when a caller supplies the process's different cwd.
const invoke = async (args) => JSON.parse((await tool.execute('live-lsp', args, undefined, undefined, { cwd: process.cwd() })).content[0].text);
const failedResult = async (args) => {
  try { await invoke(args); assert.fail('Expected a failed LSP result'); }
  catch (error) {
    return await runner.emitToolResult({ type: 'tool_result', toolName: 'lsp', toolCallId: 'live-lsp', input: args, isError: true, content: [{ type: 'text', text: error.message }], details: {} });
  }
};
try {
  const diagnostic = await invoke({ action: 'diagnostics', file: 'sample.ts' });
  assert.equal(diagnostic.success, true);
  assert.ok(diagnostic.diagnostics.some((item) => item.code === 2322), JSON.stringify(diagnostic));
  assert.ok(diagnostic.diagnostics.every((item) => item.severity !== 4), JSON.stringify(diagnostic));
  const definition = await invoke({ action: 'definition', file: 'sample.ts', line: 3, col: 15 });
  assert.ok(definition.locations.some((item) => item.file === cwd + '/sample.ts' && item.range.start.line === 0), JSON.stringify(definition));
  const absoluteDefinition = await invoke({ action: 'definition', file: cwd + '/sample.ts', line: 3, col: 15 });
  const dotRelativeDefinition = await invoke({ action: 'definition', file: './sample.ts', line: 3, col: 15 });
  assert.deepEqual(absoluteDefinition.locations, definition.locations);
  assert.deepEqual(dotRelativeDefinition.locations, definition.locations);
  // Match the built-in write tool's session cwd, including nested relative paths.
  const { createWriteToolDefinition } = await import('/opt/pi-sdk/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/write.js');
  const writer = createWriteToolDefinition(cwd);
  await writer.execute('write-relative', { path: 'nested/a.ts', content: 'export const value: number = "wrong";\n' }, undefined, undefined, { cwd });
  const nested = await invoke({ action: 'diagnostics', file: 'nested/a.ts' });
  assert.equal(nested.file, cwd + '/nested/a.ts');
  assert.ok(nested.diagnostics.some((item) => item.code === 2322), JSON.stringify(nested));
  // A bare basename must not silently search another directory when absent in cwd.
  await assert.rejects(invoke({ action: 'diagnostics', file: 'a.ts' }), /LSP_FILE_NOT_FOUND/);
  const missing = await failedResult({ action: 'diagnostics', file: 'a.ts' });
  assert.equal(missing.isError, true);
  assert.deepEqual(missing.details, { success: false, reason: 'LSP_FILE_NOT_FOUND', pathStatus: 'NOT_FOUND' });
  assert.deepEqual(JSON.parse(missing.content[0].text), missing.details);
  const references = await invoke({ action: 'references', file: 'sample.ts', line: 3, col: 15 });
  assert.ok(references.locations.length >= 3, JSON.stringify(references));
  const hover = await invoke({ action: 'hover', file: 'sample.ts', line: 3, col: 15 });
  assert.ok(JSON.stringify(hover.hover).includes('greet'), JSON.stringify(hover));
  const symbols = await invoke({ action: 'symbols', file: 'sample.ts' });
  assert.ok(symbols.symbols.some((item) => item.name === 'greet'), JSON.stringify(symbols));
  // Real disk edits must invalidate a warm server's prior diagnostic result.
  // The unused variables still produce TS6133 hints; the public diagnostics
  // contract omits hints, but must remove the repaired TS2322 error as well.
  await fs.writeFile(cwd + '/sample.ts', 'export function greet(value: number) { return value; }\nconst broken: number = greet(1);\nconst found = greet(2);\n');
  assert.deepEqual((await invoke({ action: 'diagnostics', file: 'sample.ts' })).diagnostics, []);
  const python = await invoke({ action: 'diagnostics', file: 'sample.py' });
  assert.equal(python.server, 'python');
  assert.ok(python.diagnostics.some((item) => item.severity === 1), JSON.stringify(python));
  await fs.writeFile('/tmp/outside.ts', 'export const secret = 1;');
  await fs.symlink('/tmp/outside.ts', cwd + '/escape.ts');
  await assert.rejects(invoke({ action: 'diagnostics', file: 'escape.ts' }), /LSP_PATH_DENIED/);
  const denied = await failedResult({ action: 'diagnostics', file: 'escape.ts' });
  assert.deepEqual(denied.details, { success: false, reason: 'LSP_PATH_DENIED', pathStatus: 'OUTSIDE_SESSION_SCOPE' });
  assert.equal(JSON.stringify(denied).includes('/tmp/outside.ts'), false);
  await assert.rejects(invoke({ action: 'definition', file: 'sample.ts', line: 0, col: 1 }), /LSP_POSITION_INVALID/);
  await fs.writeFile(cwd + '/large.ts', 'a'.repeat(1024 * 1024 + 1));
  await assert.rejects(invoke({ action: 'diagnostics', file: 'large.ts' }), /LSP_FILE_TOO_LARGE/);
  await assert.rejects(invoke({ action: 'symbols', file: '.' }), /LSP_FILE_INVALID/);
} finally {
  await runner.emit({ type: 'session_shutdown' });
}
await fs.appendFile(directory + '/node_modules/typescript/lib/tsserver.js', '\n// tampered\n');
await assert.rejects(verifyLspArtifact(digest), /LSP_ARTIFACT_INVALID/);
console.log('LSP_REAL_SERVERS_OK');
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
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=512m",
        "--tmpfs",
        "/workspace:rw,exec,nosuid,nodev,uid=1000,gid=1000,size=512m",
        "--entrypoint",
        "node",
        LSP_TOOLS_IMAGE,
        "--input-type=module",
        "-",
      ],
      { timeout: 180_000, maxBuffer: 1024 * 1024 },
    );
    result.child.stdin?.end(
      `${installer}\nawait writeFile('/tmp/optional-lsp.mjs', ${JSON.stringify(extension)});\n${scenario}`,
    );
    expect((await result).stdout.trim()).toBe("LSP_REAL_SERVERS_OK");
  }, 190_000);
});
