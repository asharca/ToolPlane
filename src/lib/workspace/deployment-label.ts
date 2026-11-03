export type LabelInput = {
  serverId: string | null;
  server: { name: string } | null;
  name: string | null;
  source: string | null;
  sourceRef: string | null;
};

export type DeploymentLabel = {
  name: string;
  source: string;
  ref: string | null;
};

export function deploymentLabel(d: LabelInput): DeploymentLabel {
  if (d.serverId && d.server) {
    return { name: d.name ?? d.server.name, source: "catalog", ref: null };
  }
  return {
    name: d.name ?? d.sourceRef ?? "Untitled server",
    source: d.source ?? "custom",
    ref: d.sourceRef ?? null,
  };
}

const PACKAGE_LAUNCHER_FLAGS: Record<string, true> = {
  "-y": true,
  "--yes": true,
  "--no": true,
  "--quiet": true,
  "--no-install": true,
  "--isolated": true,
  "--no-config": true,
  "--": true,
};

/** The exact package a deployment installs; null when unpinned or unsuitable for display. */
export function deploymentPinnedPackage(d: {
  source: string | null;
  sourceRef: string | null;
  installCfg: unknown;
}): string | null {
  const selector = deploymentPackageSelector(d);
  if (!selector || /:\/\/[^/]*@/.test(selector)) return null;
  return packageSelectorVersion(selector) ? selector : null;
}

function deploymentPackageSelector(d: {
  source: string | null;
  sourceRef: string | null;
  installCfg: unknown;
}): string | null {
  if (d.source === "npm" || d.source === "pypi" || d.source === "github")
    return d.sourceRef;
  if (
    d.source !== "config" ||
    !d.installCfg ||
    typeof d.installCfg !== "object" ||
    Array.isArray(d.installCfg)
  )
    return null;
  const cfg = d.installCfg as { command?: unknown; args?: unknown };
  if (cfg.command !== "npx" && cfg.command !== "uvx" && cfg.command !== "uv")
    return null;
  if (!Array.isArray(cfg.args)) return null;
  let args = cfg.args.filter((arg): arg is string => typeof arg === "string");
  if (cfg.command === "uv") {
    if (args[0] !== "tool" || args[1] !== "run") return null;
    args = args.slice(2);
  }
  const selectorFlags =
    cfg.command === "npx" ? ["-p", "--package"] : ["--from", "--with"];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (Object.hasOwn(PACKAGE_LAUNCHER_FLAGS, arg)) continue;
    const [flag, assigned] = arg.split(/=([\s\S]*)/, 2);
    if (selectorFlags.includes(flag))
      return assigned ?? args[index + 1] ?? null;
    return arg.startsWith("-") ? null : arg;
  }
  return null;
}

/** Exact version shown for a selector: npm `@x.y.z`, Python `==x.y`, or a Git commit. */
export function packageSelectorVersion(selector: string): string | null {
  const commit = /#([a-fA-F0-9]{40})$/.exec(selector)?.[1];
  if (commit) return commit.slice(0, 12);
  const python = /==(\d[A-Za-z0-9.+!-]*)$/.exec(selector)?.[1];
  if (python) return python;
  const npm =
    /^(?:@[^/@\s]+\/)?[^@\s]+@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(
      selector,
    )?.[1];
  return npm ?? null;
}
