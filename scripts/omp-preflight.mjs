import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { materializePiPackageSnapshots } from "./pi-sdk-package-files.mjs";
import { assembleOmpCapabilities } from "./omp-capabilities.mjs";
import { OmpFrameDecoder } from "./omp-rpc.mjs";

try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const cwd = "/tmp/preflight";
  const agentDir = `${cwd}/home/.omp/agent`;
  mkdirSync(agentDir, { recursive: true });
  const packages = input.packages.map((item, i) => ({
    ...item,
    root: `${cwd}/packages/${i}/snapshot`,
    manifestPath: `${cwd}/packages/${i}/manifest.json`,
  }));
  materializePiPackageSnapshots(packages);
  const nativeRoleModels = packages.flatMap((pkg) =>
    Object.keys(pkg.manifest.package.toolplane?.nativeRoleModels ?? {}).map(
      (path) => ({
        marketInstallId: pkg.marketInstallId,
        releaseId: pkg.releaseId,
        path,
        modelSelector: "preflight/loader-only",
      }),
    ),
  );
  const plugins = await assembleOmpCapabilities({
    plugins: packages,
    nativeRoleModels,
    agentDir,
  });
  for (const bundle of input.skills) {
    const root = `${agentDir}/skills/${bundle.directory}`;
    mkdirSync(root, { recursive: true });
    writeFileSync(`${root}/SKILL.md`, bundle.markdown);
    for (const file of bundle.files) {
      const path = resolve(root, file.path);
      if (!path.startsWith(`${root}/`) || file.path.includes("\\"))
        throw Error("OMP_SKILL_SCOPE");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        file.encoding === "base64"
          ? Buffer.from(file.content, "base64")
          : file.content,
      );
    }
  }
  writeFileSync(`${cwd}/plugins.json`, JSON.stringify(plugins));
  const extension = `${cwd}/preflight.mjs`;
  writeFileSync(
    extension,
    `import { readFileSync, writeFileSync } from 'node:fs';
import { loadPinnedPlugin } from '/opt/preflight/omp-hooks.mjs';
export default async function(pi) {
  const names = new Set(${JSON.stringify(input.toolNames)});
  const api = new Proxy(pi, {get(target, key) {
    if(key === 'registerTool') return tool => {if(names.has(tool.name)) throw Error('OMP_CAPABILITY_CONFLICT'); names.add(tool.name); return target.registerTool(tool);};
    return Reflect.get(target, key, target);
  }});
  for(const plugin of JSON.parse(readFileSync('${cwd}/plugins.json', 'utf8'))) await loadPinnedPlugin(api, plugin, {cwd: '${cwd}'});
  writeFileSync('${cwd}/loaded.json', JSON.stringify({ok:true}));
}`,
  );
  writeFileSync(
    `${agentDir}/config.yml`,
    JSON.stringify({
      enabledProviders: [],
      disabledProviders: [
        "omp-plugins",
        "agents-md",
        "claude",
        "codex",
        "gemini",
        "github",
        "opencode",
        "cursor",
        "windsurf",
      ],
    }),
  );
  // OMP requires a model descriptor even for RPC discovery. No prompt is sent,
  // no credentials are supplied, and the offline container has no model endpoint.
  writeFileSync(
    `${agentDir}/models.yml`,
    JSON.stringify({
      providers: {
        preflight: {
          api: "openai-completions",
          auth: "none",
          baseUrl: "http://127.0.0.1:9/v1",
          models: [
            {
              id: "loader-only",
              name: "Loader-only",
              reasoning: false,
              input: ["text"],
              contextWindow: 4096,
              maxTokens: 512,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  const child = spawn(
    "/opt/omp",
    [
      "--mode",
      "rpc-ui",
      "--model",
      "preflight/loader-only",
      "--cwd",
      cwd,
      "--session-dir",
      `${cwd}/sessions`,
      "--no-context-files",
      "--no-rules",
      "--no-tools",
      "--trusted-extension",
      extension,
    ],
    {
      cwd,
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: `${cwd}/home`,
        PI_CODING_AGENT_DIR: agentDir,
        XDG_DATA_HOME: `${cwd}/xdg`,
        PI_TELEMETRY: "0",
        PI_NO_TITLE: "1",
        PI_NO_PTY: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const { promise, resolve: done, reject } = Promise.withResolvers();
  const timer = setTimeout(() => reject(Error("OMP_PREFLIGHT_TIMEOUT")), 25000);
  const decoder = new OmpFrameDecoder();
  let size = 0;
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) reject(Error("OMP_PREFLIGHT_OUTPUT_LIMIT"));
    });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const event = decoder.decode(line);
      if (!event) return;
      if (event.type === "extension_error" || event.type === "rpc_frame_error")
        throw Error("OMP_EXTENSION_LOAD_FAILED");
      if (event.type === "ready") {
        decoder.ready(event);
        child.stdin.write(
          `${JSON.stringify({ id: "negotiate", type: "negotiate_protocol", protocolVersion: 2 })}\n`,
        );
      }
      if (event.type === "response" && event.id === "negotiate") {
        if (!event.success) throw Error("OMP_PROTOCOL_FAILED");
        child.stdin.write(
          `${JSON.stringify({ id: "commands", type: "get_available_commands" })}\n`,
        );
      }
      if (event.type === "response" && event.id === "commands") {
        if (!event.success || !existsSync(`${cwd}/loaded.json`))
          throw Error("OMP_EXTENSION_LOAD_FAILED");
        done();
      }
    } catch (error) {
      reject(error);
    }
  });
  child.once("error", reject);
  child.once("exit", () => reject(Error("OMP_PREFLIGHT_EXITED")));
  try {
    await promise;
    process.stdout.write(JSON.stringify({ ok: true }));
  } finally {
    clearTimeout(timer);
    lines.close();
    child.kill("SIGKILL");
  }
} catch {
  process.stdout.write(JSON.stringify({ ok: false }));
  process.exitCode = 1;
}
