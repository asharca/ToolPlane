import "server-only";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { resolveDockerImageDigest } from "@/lib/sandboxes/runtime";
import {
  assertRuntimeOwner,
  trackRuntimeOperation,
  runtimeAbortSignal,
  markRuntimeUncertain,
} from "@/lib/runtime/ownership-state";
import { sandboxFlags } from "./sandbox";
import type { DeploymentForSpawn, SpawnSpec } from "./spawn-spec";

export type SessionMcpPackageLaunch = {
  manager: "npm" | "python";
  packages: string[];
  command: string | null;
  args: string[];
};
const CAPTURE_VERSION = "1";
const CAPTURE_ROOT = "/var/tmp/toolplane-mcp";
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/i;
const CAPTURE_LABEL = "toolplane.mcp-capture";
const captures = new Map<string, Promise<string>>();

/** Separate dependency selection from server arguments; neither invokes the server. */
export function sessionMcpPackageLaunch(
  deployment: DeploymentForSpawn,
): SessionMcpPackageLaunch | null {
  if (deployment.source === "npm" || deployment.source === "github")
    return {
      manager: "npm",
      packages: [deployment.sourceRef ?? ""],
      command: null,
      args: [],
    };
  if (deployment.source === "pypi")
    return {
      manager: "python",
      packages: [deployment.sourceRef ?? ""],
      command: null,
      args: [],
    };
  if (deployment.source !== "config") return null;
  const cfg = deployment.installCfg as { command?: string; args?: string[] };
  if (cfg.command === "docker") return null;
  const manager = cfg.command === "npx" ? "npm" : "python";
  const args =
    cfg.command === "uv" ? (cfg.args ?? []).slice(2) : (cfg.args ?? []);
  const packages: string[] = [];
  let explicitCommand = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (
      [
        "-y",
        "--yes",
        "--no",
        "--quiet",
        "--no-install",
        "--isolated",
        "--no-config",
        "--",
      ].includes(arg)
    )
      continue;
    const [flag, assigned] = arg.split(/=([\s\S]*)/, 2);
    if (["-p", "--package", "--from", "--with"].includes(flag)) {
      const selected = assigned ?? args[++index];
      if (!selected) throw new Error("MCP_PACKAGE_SELECTOR_REQUIRED");
      packages.push(selected);
      if (flag !== "--with") explicitCommand = true;
      continue;
    }
    if (arg.startsWith("-"))
      throw new Error("MCP_PACKAGE_SELECTOR_UNSUPPORTED");
    if (explicitCommand) {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(arg) ||
        ["npm", "npx", "uv", "uvx", "pip", "pip3"].includes(arg)
      )
        throw new Error("MCP_CAPTURE_ENTRYPOINT_REQUIRED");
      return { manager, packages, command: arg, args: args.slice(index + 1) };
    }
    packages.unshift(arg);
    return { manager, packages, command: null, args: args.slice(index + 1) };
  }
  throw new Error("MCP_PACKAGE_SELECTOR_REQUIRED");
}

/** Docker is the only host executable. No platform or connection secrets enter capture. */
async function captureDocker(
  args: string[],
  options: { cleanup?: boolean; timeoutMs?: number } = {},
): Promise<string> {
  return trackRuntimeOperation(() => {
    assertRuntimeOwner(options.cleanup);
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: process.env.NODE_ENV ?? "production",
    };
    for (const key of [
      "PATH",
      "HOME",
      "DOCKER_HOST",
      "DOCKER_TLS_VERIFY",
      "DOCKER_CERT_PATH",
      "DOCKER_CONTEXT",
      "DOCKER_CONFIG",
      "XDG_RUNTIME_DIR",
    ])
      if (process.env[key]) env[key] = process.env[key];
    const child = spawn("docker", args, {
      env,
      stdio: ["ignore", "pipe", "ignore"],
      ...(!options.cleanup && runtimeAbortSignal()
        ? { signal: runtimeAbortSignal() }
        : {}),
    });
    let output = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(output);
    };
    const timer = setTimeout(() => {
      markRuntimeUncertain();
      child.kill("SIGKILL");
      finish(new Error("MCP_CAPTURE_DOCKER_TIMEOUT"));
    }, options.timeoutMs ?? 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (output.length + chunk.length > 1024 * 1024) {
        child.kill("SIGKILL");
        finish(new Error("MCP_CAPTURE_OUTPUT_LIMIT"));
      } else output += chunk.toString();
    });
    child.once("error", () =>
      finish(new Error("MCP_CAPTURE_DOCKER_UNAVAILABLE")),
    );
    child.once("close", (code) =>
      finish(code === 0 ? undefined : new Error("MCP_CAPTURE_DOCKER_FAILED")),
    );
    return promise;
  }, options.cleanup);
}

async function cachedImage(
  tag: string,
  checksum: string,
): Promise<string | null> {
  let raw: string;
  try {
    raw = await captureDocker([
      "image",
      "inspect",
      "--format",
      '{{json .Id}} {{json (index .Config.Labels "toolplane.mcp-definition")}} {{json (index .Config.Labels "toolplane.mcp-capture-version")}}',
      tag,
    ]);
  } catch (error) {
    // Distinguish an absent artifact from daemon/ownership errors before preparing anything.
    const ids = await captureDocker([
      "image",
      "ls",
      "--quiet",
      "--no-trunc",
      tag,
    ]);
    if (!ids.trim()) return null;
    throw error;
  }
  const match =
    /^"(sha256:[a-f0-9]{64})" "([a-f0-9]{64})" "([0-9]+)"\s*$/i.exec(raw);
  if (!match || match[2] !== checksum || match[3] !== CAPTURE_VERSION)
    throw new Error("MCP_CAPTURE_IDENTITY_MISMATCH");
  return match[1];
}

const NPM_BIN = `const fs=require('node:fs');const root=process.argv[1];let command=process.argv[2];if(!command){const deps=Object.keys(JSON.parse(fs.readFileSync(root+'/package.json','utf8')).dependencies||{});if(deps.length!==1)throw Error('ambiguous package');const pkg=JSON.parse(fs.readFileSync(root+'/node_modules/'+deps[0]+'/package.json','utf8'));const bins=typeof pkg.bin==='string'?{[pkg.name.split('/').pop()]:pkg.bin}:pkg.bin||{};const names=Object.keys(bins);const preferred=pkg.name.split('/').pop();command=names.includes(preferred)?preferred:new Set(Object.values(bins)).size===1?names[0]:null;}if(!command||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(command)||!fs.existsSync(root+'/node_modules/.bin/'+command))throw Error('MCP_CAPTURE_ENTRYPOINT_REQUIRED');fs.writeFileSync(root+'/entrypoint',root+'/node_modules/.bin/'+command);`;
const PYTHON_BIN = `import importlib.metadata as m, pathlib, re, sys\nroot, command, selector = sys.argv[1:]\nif not command:\n name = re.split(r'[=\\[]', selector)[0]\n entries = list(m.distribution(name).entry_points.select(group='console_scripts'))\n preferred = name.replace('_', '-')\n matches = [entry.name for entry in entries if entry.name == preferred]\n command = matches[0] if matches else entries[0].name if len(entries) == 1 else ''\nif not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', command) or not pathlib.Path(root+'/venv/bin/'+command).is_file():\n raise RuntimeError('MCP_CAPTURE_ENTRYPOINT_REQUIRED')\npathlib.Path(root+'/entrypoint').write_text(root+'/venv/bin/'+command)\n`;

async function captureRuntimeImage(
  spec: Extract<SpawnSpec, { kind: "bridge" }>,
  launch: SessionMcpPackageLaunch | null,
  checksum: string,
  tag: string,
): Promise<string> {
  if (!spec.image) throw new Error("MCP_CAPTURE_IMAGE_REQUIRED");
  const base = await resolveDockerImageDigest(spec.image);
  const name = `toolplane-mcp-capture-${randomUUID()}`;
  // Only the capture layer is writable; no host paths, work volumes, credentials or Docker socket.
  const hardening = sandboxFlags("isolated").filter(
    (arg) => !["--rm", "--read-only"].includes(arg),
  );
  const setup =
    launch?.manager === "npm"
      ? 'mkdir -p "$1"; root="$1"; command="$2"; selector="$3"; metadata="$4"; shift 4; npm install --prefix "$root" --no-audit --no-fund --package-lock=true -- "$@" >/dev/null 2>&1; node -e "$metadata" "$root" "$command"'
      : 'mkdir -p "$1"; root="$1"; command="$2"; selector="$3"; metadata="$4"; shift 4; uv venv --python python3 "$root/venv" >/dev/null 2>&1; uv pip install --python "$root/venv/bin/python" "$@" >/dev/null 2>&1; "$root/venv/bin/python" -c "$metadata" "$root" "$command" "$selector"';
  let created = false;
  let failure: unknown;
  let failed = false;
  let capturedImageId = "";
  try {
    const changes: string[] = [];
    if (launch) {
      await captureDocker([
        "create",
        ...hardening,
        "--user",
        "65534:65534",
        "--name",
        name,
        "--label",
        `${CAPTURE_LABEL}=true`,
        "--env",
        "HOME=/tmp",
        "--env",
        "npm_config_cache=/tmp/.npm",
        "--env",
        "UV_CACHE_DIR=/tmp/.uv",
        "--env",
        "UV_PYTHON_DOWNLOADS=never",
        "--entrypoint",
        "/bin/sh",
        base,
        "-ec",
        setup,
        "capture",
        CAPTURE_ROOT,
        launch.command ?? "",
        launch.packages[0],
        launch.manager === "npm" ? NPM_BIN : PYTHON_BIN,
        ...launch.packages,
      ]);
      created = true;
      await captureDocker(["start", "--attach", name], { timeoutMs: 300_000 });
      const code = (
        await captureDocker([
          "inspect",
          "--format",
          "{{.State.ExitCode}}",
          name,
        ])
      ).trim();
      if (code !== "0") throw new Error("MCP_DEPENDENCY_CAPTURE_FAILED");
      // Read the controlled metadata file, never installation logs.
      const raw = await captureDocker([
        "cp",
        `${name}:${CAPTURE_ROOT}/entrypoint`,
        "-",
      ]);
      const executable = raw.match(
        /\/var\/tmp\/toolplane-mcp\/(?:node_modules\/\.bin|venv\/bin)\/[A-Za-z0-9][A-Za-z0-9._-]*/,
      )?.[0];
      if (!executable) throw new Error("MCP_CAPTURE_ENTRYPOINT_REQUIRED");
      changes.push(
        "--change",
        `ENTRYPOINT ${JSON.stringify([executable])}`,
        "--change",
        "CMD []",
        "--change",
        `WORKDIR ${CAPTURE_ROOT}`,
      );
    } else {
      // Snapshot Docker recipes without ever starting their configured server.
      const originalCommand: unknown = JSON.parse(
        await captureDocker([
          "image",
          "inspect",
          "--format",
          "{{json .Config.Cmd}}",
          base,
        ]),
      );
      if (
        originalCommand !== null &&
        (!Array.isArray(originalCommand) ||
          originalCommand.some((value) => typeof value !== "string"))
      )
        throw new Error("MCP_CAPTURE_IMAGE_INVALID");
      await captureDocker([
        "create",
        ...hardening,
        "--name",
        name,
        "--label",
        `${CAPTURE_LABEL}=true`,
        base,
        "/toolplane-capture-not-executed",
      ]);
      created = true;
      changes.push("--change", `CMD ${JSON.stringify(originalCommand ?? [])}`);
    }
    const identity = createHash("sha256")
      .update(
        JSON.stringify({
          version: CAPTURE_VERSION,
          base,
          packages: launch?.packages ?? [],
          command: launch?.command ?? null,
        }),
      )
      .digest("hex");
    const id = (
      await captureDocker(
        [
          "commit",
          ...changes,
          "--change",
          `LABEL toolplane.mcp-definition=${checksum}`,
          "--change",
          `LABEL toolplane.mcp-capture-version=${CAPTURE_VERSION}`,
          "--change",
          `LABEL toolplane.mcp-artifact=${identity}`,
          "--change",
          `LABEL ${CAPTURE_LABEL}=false`,
          name,
          tag,
        ],
        { timeoutMs: 60_000 },
      )
    ).trim();
    if (!IMAGE_ID.test(id)) throw new Error("MCP_CAPTURE_IDENTITY_MISMATCH");
    capturedImageId = id;
  } catch (error) {
    failed = true;
    failure = error;
  }
  if (created) {
    try {
      await captureDocker(["rm", "--force", "--volumes", name], {
        cleanup: true,
      });
    } catch (cleanupError) {
      markRuntimeUncertain();
      throw new AggregateError(
        failed ? [failure, cleanupError] : [cleanupError],
        "MCP_CAPTURE_CLEANUP_FAILED",
      );
    }
  }
  if (failed) throw failure;
  return capturedImageId;
}

/** Prepare once outside publication transactions; prepare:false is strictly inspect-only. */
export async function prepareSessionMcpRuntimeImage(
  deployment: DeploymentForSpawn,
  spec: Extract<SpawnSpec, { kind: "bridge" }>,
  checksum: string,
  options: { prepare?: boolean } = {},
): Promise<string> {
  assertRuntimeOwner();
  const launch = sessionMcpPackageLaunch(deployment);
  const tag = `toolplane-mcp-runtime:${checksum}`;
  const existing = await cachedImage(tag, checksum);
  if (existing) return existing;
  if (options.prepare === false) throw new Error("MCP_PREPARATION_REQUIRED");
  const pending = captures.get(checksum);
  if (pending) return pending;
  const capture = captureRuntimeImage(spec, launch, checksum, tag);
  captures.set(checksum, capture);
  try {
    return await capture;
  } finally {
    captures.delete(checksum);
  }
}

/** Inspection by immutable ID also permits rollback after a mutable base tag moves. */
export async function validateSessionMcpRuntimeImage(
  pinnedDigest: string,
  checksum: string,
): Promise<string> {
  if (!IMAGE_ID.test(pinnedDigest))
    throw new Error("MCP_CAPTURE_IDENTITY_MISMATCH");
  const existing = await cachedImage(pinnedDigest, checksum);
  if (!existing || existing !== pinnedDigest)
    throw new Error("MCP_PREPARATION_REQUIRED");
  return existing;
}

/** Recovery removes only labelled unfinished capture containers, never captured images. */
export async function removeStaleSessionMcpCaptures(): Promise<void> {
  const ids = (
    await captureDocker(
      ["ps", "--all", "--quiet", "--filter", `label=${CAPTURE_LABEL}=true`],
      { cleanup: true },
    )
  )
    .split(/\s+/)
    .filter(Boolean);
  for (const id of ids)
    await captureDocker(["rm", "--force", "--volumes", id], { cleanup: true });
}
