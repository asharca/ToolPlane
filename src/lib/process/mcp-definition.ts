import { isOAuthConfig } from "@/lib/remote-mcp/oauth/config";
import { createHash } from "node:crypto";
import { resolveSpawnSpec, type DeploymentForSpawn } from "./spawn-spec";
import {
  prepareSessionMcpRuntimeImage,
  validateSessionMcpRuntimeImage,
} from "./mcp-runtime-image";
import type { Prisma } from "@prisma/client";
import { assertAssistantRemoteDeployment } from "@/lib/remote-mcp/classification";

export type McpRuntimeFileIdentity = {
  id: string;
  path: string;
  encryptedContent: unknown;
  size: number;
};

export function mcpRuntimeFilesIdentity(
  rows: readonly McpRuntimeFileIdentity[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        rows.map((row) => ({
          id: row.id,
          path: row.path,
          encryptedContent: row.encryptedContent,
          size: row.size,
        })),
      ),
    )
    .digest("hex");
}

/** A ciphertext identity pins secret config bytes without revealing or copying them. */
export async function mcpRuntimeFilesChecksum(
  tx: Prisma.TransactionClient,
  deploymentId: string,
): Promise<string> {
  const rows = await tx.deploymentConfigFile.findMany({
    where: { deploymentId },
    select: { id: true, path: true, encryptedContent: true, size: true },
    orderBy: [{ path: "asc" }, { id: "asc" }],
  });
  return mcpRuntimeFilesIdentity(rows);
}

/** Pins executable recipe configuration, never credential values or live catalogs. */
export function mcpDefinitionChecksum(deployment: DeploymentForSpawn): string {
  const cfg =
    deployment.installCfg &&
    typeof deployment.installCfg === "object" &&
    !Array.isArray(deployment.installCfg)
      ? (deployment.installCfg as Record<string, unknown>)
      : {};
  const env =
    cfg.env && typeof cfg.env === "object" && !Array.isArray(cfg.env)
      ? (cfg.env as Record<string, unknown>)
      : {};
  const headerEnv =
    cfg.headerEnv &&
    typeof cfg.headerEnv === "object" &&
    !Array.isArray(cfg.headerEnv)
      ? Object.entries(cfg.headerEnv).sort(([left], [right]) =>
          left.localeCompare(right),
        )
      : [];
  const envBindings =
    cfg.envBindings &&
    typeof cfg.envBindings === "object" &&
    !Array.isArray(cfg.envBindings)
      ? Object.entries(cfg.envBindings).sort(([left], [right]) =>
          left.localeCompare(right),
        )
      : [];
  return createHash("sha256")
    .update(
      JSON.stringify({
        source: deployment.source,
        sourceRef: deployment.sourceRef,
        command: cfg.command ?? null,
        args: cfg.args ?? [],
        startCommand: cfg.startCommand ?? null,
        network: cfg.network ?? "isolated",
        transport: cfg.transport ?? "streamable-http",
        authType: cfg.authType ?? "none",
        bearerEnv: cfg.bearerEnv ?? null,
        headerEnv,
        timeoutMs: cfg.timeoutMs ?? 60_000,
        allowUnsafeHttp: cfg.allowUnsafeHttp === true,
        environmentKeys: Object.keys(env).sort(),
        ...(cfg.cwd !== undefined ? { cwd: cfg.cwd } : {}),
        ...(envBindings.length ? { envBindings } : {}),
        ...(deployment.runtimeTarget && deployment.runtimeTarget !== "managed"
          ? {
              runtimeTarget: deployment.runtimeTarget,
              runtimeSandboxId: deployment.runtimeSandboxId ?? null,
            }
          : {}),
      }),
    )
    .digest("hex");
}

/** Opt-in placement: session runtimes run inside the Agent's own sandbox. */
export function mcpRunsInAgentSandbox(deployment: {
  installCfg: unknown;
}): boolean {
  const cfg = deployment.installCfg;
  return (
    !!cfg &&
    typeof cfg === "object" &&
    !Array.isArray(cfg) &&
    !isOAuthConfig(cfg) &&
    (cfg as Record<string, unknown>).runInAgentSandbox === true
  );
}

/** Only Docker-launched (stdio) recipes can join an Agent sandbox. */
export function supportsAgentSandboxPlacement(
  deployment: DeploymentForSpawn,
): boolean {
  if (deployment.source === "sandbox" || isOAuthConfig(deployment.installCfg))
    return false;
  try {
    const spec = resolveSpawnSpec(deployment);
    return (
      spec.kind === "bridge" &&
      spec.command === "docker" &&
      spec.args[0] === "run"
    );
  } catch {
    return false;
  }
}

const EXACT_GIT_SHA = /^[a-fA-F0-9]{40}$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const GIT_PATH_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const SUBDIRECTORY_FRAGMENT =
  /^subdirectory=([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)$/;

export class McpRecipePinError extends Error {
  readonly code = "MCP_EXACT_PACKAGE_VERSION_REQUIRED" as const;

  constructor(message: string) {
    super(message);
    this.name = "McpRecipePinError";
  }
}

function isSupportedHttpsGitHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (!host || host.length > 253 || host.includes(":")) return false;
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".arpa")
  )
    return false;
  const labels = host.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((label) => DNS_LABEL.test(label))) return false;
  // Require an alphabetic TLD to reject IPv4 and dotted numeric literals.
  return /[a-z]/.test(labels[labels.length - 1]);
}

/** Python Git selectors must use HTTPS without credentials and pin a full 40-char commit SHA. */
export function isPinnedPythonHttpsGitSelector(value: string): boolean {
  if (!value || value.length > 2_048 || /\s/.test(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 32 || code === 127) return false;
  }
  if (!value.startsWith("git+https://")) return false;
  const rest = value.slice("git+".length);
  const hashParts = rest.split("#");
  if (hashParts.length > 2) return false;
  const [urlWithRev, fragment] = hashParts;
  if (fragment !== undefined) {
    const subdir = SUBDIRECTORY_FRAGMENT.exec(fragment)?.[1];
    if (
      !subdir ||
      subdir.split("/").some((segment) => segment === "." || segment === "..")
    )
      return false;
  }
  const atParts = urlWithRev.split("@");
  if (atParts.length !== 2) return false;
  const [repoUrl, revision] = atParts;
  if (!EXACT_GIT_SHA.test(revision)) return false;
  if (repoUrl.includes("%") || repoUrl.includes("\\")) return false;
  let parsed: URL;
  try {
    parsed = new URL(repoUrl);
  } catch {
    return false;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.port === "0" ||
    !isSupportedHttpsGitHost(parsed.hostname)
  )
    return false;
  const rawPathStart = repoUrl.indexOf("/", "https://".length);
  if (rawPathStart < 0) return false;
  const rawPath = repoUrl.slice(rawPathStart);
  if (rawPath !== parsed.pathname || rawPath.endsWith("/")) return false;
  const segments = rawPath.slice(1).split("/");
  if (segments.length < 2 || segments.length > 10) return false;
  return segments.every(
    (segment) =>
      GIT_PATH_SEGMENT.test(segment) &&
      segment !== "." &&
      segment !== ".." &&
      !segment.startsWith("-"),
  );
}

/** Launchers may select exact versions/commits, never floating registry tags. */
export function assertSessionMcpRecipePinned(
  deployment: DeploymentForSpawn,
): void {
  const exactNpm =
    /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
  const exactGit =
    /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?#[a-fA-F0-9]{40}$/;
  const exactPython =
    /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9_,.-]+\])?==\d[A-Za-z0-9.+!-]*$/;
  function fail(
    kind: "python" | "npm" | "pypi" | "general" = "general",
  ): never {
    const guidance =
      kind === "python"
        ? "Use an exact Python version (package==1.2.3) or a full 40-character HTTPS Git commit (git+https://github.com/owner/repo.git@<40-char-sha>)."
        : kind === "pypi"
          ? "Use an exact Python package version (package==1.2.3)."
          : kind === "npm"
            ? "Use an exact npm version (package@1.2.3) or a full 40-character GitHub commit (https://github.com/owner/repo#<40-char-sha>)."
            : "Use an exact package version (package@1.2.3 or package==1.2.3) or a full 40-character HTTPS Git commit (git+https://github.com/owner/repo.git@<40-char-sha> for uvx/uv, or https://github.com/owner/repo#<40-char-sha> for npm/GitHub).";
    throw new McpRecipePinError(
      `MCP_EXACT_PACKAGE_VERSION_REQUIRED: Revision was not published. ${guidance}`,
    );
  }
  if (deployment.source === "remote" || deployment.source === "docker") return;
  if (deployment.source === "npm") {
    if (!exactNpm.test(deployment.sourceRef ?? "")) fail("npm");
    return;
  }
  if (deployment.source === "github") {
    if (!exactGit.test(deployment.sourceRef ?? "")) fail("npm");
    return;
  }
  if (deployment.source === "pypi") {
    if (!exactPython.test(deployment.sourceRef ?? "")) fail("pypi");
    return;
  }
  if (deployment.source !== "config") fail();
  if (
    !deployment.installCfg ||
    typeof deployment.installCfg !== "object" ||
    Array.isArray(deployment.installCfg)
  )
    fail();
  const cfg = deployment.installCfg as { command?: string; args?: unknown };
  if (cfg.command === "docker") return;
  if (
    !Array.isArray(cfg.args) ||
    cfg.args.some((arg) => typeof arg !== "string")
  )
    fail();
  let args: string[] = cfg.args;
  if (cfg.command === "uv") {
    if (args[0] !== "tool" || args[1] !== "run") fail("python");
    args = args.slice(2);
  } else if (cfg.command !== "npx" && cfg.command !== "uvx") fail();
  const python = cfg.command !== "npx";
  const errorKind = python ? "python" : "npm";
  let pinnedSelector = false;
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
    if (
      (python && ["--from", "--with"].includes(flag)) ||
      (!python && ["-p", "--package"].includes(flag))
    ) {
      const value = assigned ?? args[++index];
      if (
        !value ||
        !(python
          ? exactPython.test(value) || isPinnedPythonHttpsGitSelector(value)
          : exactNpm.test(value) || exactGit.test(value))
      )
        fail(errorKind);
      if (flag !== "--with") pinnedSelector = true;
      continue;
    }
    if (arg.startsWith("-")) fail(errorKind);
    if (
      !pinnedSelector &&
      !(python
        ? exactPython.test(arg)
        : exactNpm.test(arg) || exactGit.test(arg))
    )
      fail(errorKind);
    return;
  }
  fail(errorKind);
}

export type PreparedSessionMcpDefinition = {
  definitionChecksum: string;
  runtimeImageDigest: string | null;
};

/** Prepare immutable dependencies outside publication; never starts the MCP server or calls its tools. */
export async function prepareSessionMcpDefinition(
  deployment: DeploymentForSpawn,
  options: { prepare?: boolean } = {},
): Promise<PreparedSessionMcpDefinition> {
  if (deployment.source === "remote") {
    assertAssistantRemoteDeployment(deployment);
    return {
      definitionChecksum: mcpDefinitionChecksum(deployment),
      runtimeImageDigest: null,
    };
  }
  const spec = resolveSpawnSpec(deployment);
  if (spec.kind !== "bridge" || spec.command !== "docker" || !spec.image)
    throw new Error("MCP_SESSION_RECIPE_UNSUPPORTED");
  assertSessionMcpRecipePinned(deployment);
  const definitionChecksum = mcpDefinitionChecksum(deployment);
  const runtimeImageDigest = await prepareSessionMcpRuntimeImage(
    deployment,
    spec,
    definitionChecksum,
    options,
  );
  return { definitionChecksum, runtimeImageDigest };
}

/** Publication validates the reviewed artifact without network, rebuild or mutable tag lookup. */
export async function prepareExistingSessionMcpDefinition(
  deployment: DeploymentForSpawn,
  pinnedDigest: string | null,
): Promise<PreparedSessionMcpDefinition> {
  const definitionChecksum = mcpDefinitionChecksum(deployment);
  if (deployment.source === "remote") {
    assertAssistantRemoteDeployment(deployment);
    if (pinnedDigest !== null) throw new Error("MCP_CAPTURE_IDENTITY_MISMATCH");
    return { definitionChecksum, runtimeImageDigest: null };
  }
  const spec = resolveSpawnSpec(deployment);
  assertSessionMcpRecipePinned(deployment);
  if (spec.kind !== "bridge" || spec.command !== "docker" || !pinnedDigest)
    throw new Error("MCP_SESSION_RECIPE_UNSUPPORTED");
  return {
    definitionChecksum,
    runtimeImageDigest: await validateSessionMcpRuntimeImage(
      pinnedDigest,
      definitionChecksum,
    ),
  };
}
