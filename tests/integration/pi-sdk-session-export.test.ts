// @vitest-environment node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "session-export-test-"));
  roots.push(root);
  const runtimeSessionId = randomUUID();
  const directory = join(root, "sessions", runtimeSessionId);
  await mkdir(directory, { recursive: true });
  const sessionFile = join(directory, "2026-11-15_session.jsonl");
  const id = randomUUID();
  const entries = [
    {
      type: "session",
      version: 3,
      id,
      timestamp: "2026-11-15T00:00:00.000Z",
      cwd: root,
    },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-11-15T00:00:00.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "Export persisted request" }],
        timestamp: 1,
      },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-11-15T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Export persisted answer" }],
        api: "openai-completions",
        provider: "toolplane",
        model: "export-only",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      },
    },
  ];
  await writeFile(
    sessionFile,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  await writeFile(
    join(root, "sessions", `${runtimeSessionId}.json`),
    JSON.stringify({
      runtimeKind: "pi-sdk",
      sessionFile,
      sessionId: id,
      sessionPersisted: true,
    }),
  );
  return { root, runtimeSessionId, sessionFile };
}
async function exportNative(config: {
  stateRoot: string;
  runtimeSessionId: string;
  jsonl?: string;
}) {
  const source = await readFile(
    join(process.cwd(), "scripts/pi-sdk-session-export.mjs"),
    "utf8",
  );
  const child = spawn(process.execPath, ["--input-type=module", "-"], {
    env: {
      ...process.env,
      NODE_CHANNEL_FD: undefined,
      NODE_CHANNEL_SERIALIZATION_MODE: undefined,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  child.once("error", reject);
  child.once("close", (code) =>
    code === 0
      ? resolve(stdout)
      : reject(new Error(`Export process failed (${code}): ${stderr}`)),
  );
  child.stdin.end(
    `${source}\nawait exportSession(${JSON.stringify({ ...config, packageRoot: process.cwd() })});`,
  );
  return JSON.parse(await promise) as { content?: string; error?: string };
}

it("exports native persisted entries beside a concurrent partial append, without mutating live history", async () => {
  const { root, runtimeSessionId, sessionFile } = await fixture();
  await appendFile(sessionFile, '{"type":"message","id":"incomplete');
  const before = await readFile(sessionFile, "utf8");
  const result = await exportNative({ stateRoot: root, runtimeSessionId });
  expect(result.error).toBeUndefined();
  const exported = Buffer.from(result.content ?? "", "base64").toString("utf8");
  const entries = exported
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(entries[0]).toMatchObject({ type: "session", cwd: root });
  expect(exported).toContain("Export persisted answer");
  expect(exported).not.toContain("incomplete");
  expect(await readFile(sessionFile, "utf8")).toBe(before);
});

it("renders SDK HTML from the supplied sanitized snapshot without loading project extensions", async () => {
  const { root, runtimeSessionId, sessionFile } = await fixture();
  const extensions = join(root, ".pi", "extensions");
  await mkdir(extensions, { recursive: true });
  await writeFile(
    join(extensions, "deny.mjs"),
    'throw new Error("PROJECT_EXTENSION_MUST_NOT_RUN");',
  );
  const jsonl = await readFile(sessionFile, "utf8");
  const result = await exportNative({
    stateRoot: root,
    runtimeSessionId,
    jsonl,
  });
  expect(result.error).toBeUndefined();
  const html = Buffer.from(result.content ?? "", "base64").toString("utf8");
  expect(html.toLowerCase()).toContain("<!doctype html>");
  const encoded = html.match(
    /<script id="session-data" type="application\/json">([^<]+)<\/script>/,
  )?.[1];
  expect(encoded).toBeDefined();
  const transcript = JSON.parse(
    Buffer.from(encoded ?? "", "base64").toString("utf8"),
  );
  expect(transcript.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "message",
        message: expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "Export persisted answer" }],
        }),
      }),
    ]),
  );
  expect(await readFile(sessionFile, "utf8")).toBe(jsonl);
});

it("rejects a persisted native pointer outside this conversation", async () => {
  const { root, runtimeSessionId } = await fixture();
  await writeFile(
    join(root, "sessions", `${runtimeSessionId}.json`),
    JSON.stringify({
      runtimeKind: "pi-sdk",
      sessionFile: join(root, "sessions", `${runtimeSessionId}.json`),
    }),
  );
  const result = await exportNative({ stateRoot: root, runtimeSessionId });
  expect(result.error).toBe("SESSION_EXPORT_NATIVE_INVALID");
  expect(result.content).toBeUndefined();
});
