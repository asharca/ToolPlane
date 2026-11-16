// Trusted export-only entry point, supplied through stdin by the control plane.
// Never loads conversation extensions, credentials, tools, or starts a model turn.
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, join, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

const LIMIT = 8 * 1024 * 1024;
const failures = new Set([
  "SESSION_EXPORT_TOO_LARGE",
  "SESSION_EXPORT_NATIVE_MISSING",
  "SESSION_EXPORT_NATIVE_INVALID",
]);
function fail(code) {
  throw new Error(code);
}
function within(root, path) {
  const rel = relative(root, path);
  return (
    rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"))
  );
}
function boundedRead(path, limit = LIMIT) {
  const fd = openSync(path, "r");
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) fail("SESSION_EXPORT_NATIVE_INVALID");
    if (info.size > limit) fail("SESSION_EXPORT_TOO_LARGE");
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(
        fd,
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (!count) break;
      offset += count;
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
function snapshot(config) {
  const root = realpathSync(config.stateRoot);
  const directory = realpathSync(
    join(root, "sessions", config.runtimeSessionId),
  );
  if (!within(root, directory)) fail("SESSION_EXPORT_NATIVE_INVALID");
  const statePath = join(root, "sessions", `${config.runtimeSessionId}.json`);
  let file;
  if (existsSync(statePath)) {
    if (!within(root, realpathSync(statePath)))
      fail("SESSION_EXPORT_NATIVE_INVALID");
    const state = JSON.parse(boundedRead(statePath, 1024 * 1024));
    if (state.runtimeKind !== "pi-sdk") fail("SESSION_EXPORT_NATIVE_INVALID");
    file = state.sessionFile;
  }
  // The first active turn can persist native entries before its state pointer exists.
  if (!file) {
    const candidates = readdirSync(directory)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => ({ path: join(directory, name), name }));
    candidates.sort((a, b) => b.name.localeCompare(a.name));
    file = candidates[0]?.path;
  }
  if (typeof file !== "string" || !existsSync(file))
    fail("SESSION_EXPORT_NATIVE_MISSING");
  const actual = realpathSync(file);
  if (!within(directory, actual)) fail("SESSION_EXPORT_NATIVE_INVALID");
  const text = boundedRead(actual);
  // A concurrent append is not a complete persisted entry until its newline arrives.
  const complete = text.slice(0, text.lastIndexOf("\n") + 1);
  if (!complete.trim()) fail("SESSION_EXPORT_NATIVE_MISSING");
  const entries = complete
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  if (entries[0]?.type !== "session") fail("SESSION_EXPORT_NATIVE_INVALID");
  return complete;
}

export async function exportSession(config) {
  let temporary;
  let session;
  try {
    const sdkEntry = realpathSync(
      join(
        config.packageRoot,
        "node_modules/@earendil-works/pi-coding-agent/dist/index.js",
      ),
    );
    const sdk = await import(pathToFileURL(sdkEntry).href);
    const { serializeSessionBranch } = await import(
      pathToFileURL(join(dirname(sdkEntry), "core/session-export.js")).href
    );
    temporary = mkdtempSync("/tmp/toolplane-session-export-");
    const jsonl = config.jsonl === undefined ? snapshot(config) : config.jsonl;
    if (Buffer.byteLength(jsonl) > LIMIT) fail("SESSION_EXPORT_TOO_LARGE");
    const input = join(temporary, "session.jsonl");
    writeFileSync(input, jsonl, { mode: 0o600 });
    // Open only the snapshot: SDK restoration must never mutate the live session.
    const manager = sdk.SessionManager.open(input, temporary);
    let content;
    if (config.jsonl === undefined) {
      content = serializeSessionBranch(manager);
    } else {
      const { InMemoryCredentialStore } = await import(
        pathToFileURL(
          join(
            dirname(
              findPackageJSON("@earendil-works/pi-ai", pathToFileURL(sdkEntry)),
            ),
            "dist/index.js",
          ),
        ).href
      );
      const modelRuntime = await sdk.ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        modelsStorePath: join(temporary, "models.json"),
        refreshOnCreate: false,
      });
      const settingsManager = sdk.SettingsManager.inMemory({
        packages: [],
        extensions: [],
        skills: [],
        prompts: [],
        themes: [],
        retry: { enabled: false },
      });
      const resourceLoader = new sdk.DefaultResourceLoader({
        cwd: temporary,
        agentDir: temporary,
        settingsManager,
        noExtensions: true,
        disabledBuiltinExtensions: ["mcp"],
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await resourceLoader.reload();
      ({ session } = await sdk.createAgentSession({
        cwd: temporary,
        agentDir: temporary,
        modelRuntime,
        settingsManager,
        resourceLoader,
        sessionManager: manager,
        noTools: "all",
        tools: [],
      }));
      const output = join(temporary, "session.html");
      await session.exportToHtml(output);
      if (statSync(output).size > LIMIT) fail("SESSION_EXPORT_TOO_LARGE");
      content = readFileSync(output, "utf8");
    }
    if (Buffer.byteLength(content) > LIMIT) fail("SESSION_EXPORT_TOO_LARGE");
    process.stdout.write(
      JSON.stringify({ content: Buffer.from(content).toString("base64") }),
    );
  } catch (error) {
    const code = failures.has(error?.message)
      ? error.message
      : error?.code === "ENOENT"
        ? "SESSION_EXPORT_NATIVE_MISSING"
        : "SESSION_EXPORT_FAILED";
    process.stdout.write(JSON.stringify({ error: code }));
  } finally {
    session?.dispose();
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}
