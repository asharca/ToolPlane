import "server-only";

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { resolveServerSourceVersion } from "@/lib/admin/server-source";
import type { DeploymentForSpawn } from "./spawn-spec";

type McpRecipe = Pick<
  DeploymentForSpawn,
  "source" | "sourceRef" | "installCfg"
>;

export class McpPinningError extends Error {
  readonly code = "mcpVersionResolutionFailed";

  constructor(options?: ErrorOptions) {
    super("mcpVersionResolutionFailed", options);
    this.name = "McpPinningError";
  }
}

/** Resolve mutable package selectors before persisting or capturing a definition. */
export async function resolvePinnedMcpRecipe(
  deployment: McpRecipe,
): Promise<{ sourceRef: string | null; installCfg: unknown }> {
  try {
    const { source, sourceRef, installCfg } = deployment;
    if (source === "npm" || source === "pypi" || source === "github") {
      return {
        sourceRef: await resolveServerSourceVersion(source, sourceRef ?? ""),
        installCfg,
      };
    }
    if (
      source !== "config" ||
      !installCfg ||
      typeof installCfg !== "object" ||
      Array.isArray(installCfg)
    ) {
      return { sourceRef, installCfg };
    }
    const cfg = installCfg as Record<string, unknown>;
    const command = cfg.command;
    if (command !== "npx" && command !== "uvx" && command !== "uv")
      return { sourceRef, installCfg };
    if (
      !Array.isArray(cfg.args) ||
      cfg.args.some((arg) => typeof arg !== "string")
    )
      throw new Error("Invalid package arguments.");
    const args = [...cfg.args] as string[];
    const python = command !== "npx";
    let start = 0;
    if (command === "uv") {
      if (args[0] !== "tool" || args[1] !== "run")
        return { sourceRef, installCfg };
      start = 2;
    }
    const selectors: {
      index: number;
      prefix: string;
      ref: string;
      source: "npm" | "pypi" | "github";
    }[] = [];
    let executableFound = false;
    for (let index = start; index < args.length; index += 1) {
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
      let ref: string;
      let prefix = "";
      if (
        (python && ["--from", "--with"].includes(flag)) ||
        (!python && ["-p", "--package"].includes(flag))
      ) {
        ref = assigned ?? args[++index];
        if (!ref) throw new Error("Missing package selector.");
        if (assigned !== undefined) prefix = `${flag}=`;
      } else {
        if (arg.startsWith("-")) return { sourceRef, installCfg };
        executableFound = true;
        if (selectors.length) break;
        ref = arg;
      }
      if (!python) {
        ref = ref
          .replace(/^git\+https:\/\/github\.com\//, "https://github.com/")
          .replace(/^github:/, "https://github.com/");
        if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#[^\s]+)?$/.test(ref))
          ref = `https://github.com/${ref}`;
      }
      const source = python
        ? "pypi"
        : ref.startsWith("https://github.com/")
          ? "github"
          : "npm";
      // Preserve ordinary deployment support for non-registry recipes. Session
      // admission still applies its existing immutable recipe validation.
      const supported =
        source === "github"
          ? /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?(?:#[^\s]+)?$/.test(
              ref,
            )
          : source === "pypi"
            ? /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9_,.-]+\])?(?:[<>=!~].+)?$/.test(
                ref,
              )
            : /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+(?:@[^\s/]+)?$/.test(ref);
      if (!supported) return { sourceRef, installCfg };
      selectors.push({ index, prefix, ref, source });
      if (executableFound) break;
    }
    if (!executableFound) throw new Error("Missing package executable.");
    for (const selector of selectors) {
      args[selector.index] =
        selector.prefix +
        (await resolveServerSourceVersion(selector.source, selector.ref));
    }
    return { sourceRef, installCfg: { ...cfg, args } };
  } catch (cause) {
    throw new McpPinningError({ cause });
  }
}

/** Caller must authorize the workspace mutation before calling; no transaction may wrap this function. */
export async function ensureWorkspaceMcpDeploymentPinned(input: {
  workspaceId: string;
  deploymentId: string;
}) {
  const where = { id: input.deploymentId, workspaceId: input.workspaceId };
  const deployment = await db.deployment.findFirst({
    where,
    include: { server: true },
  });
  if (!deployment) throw new McpPinningError();
  const pinned = await resolvePinnedMcpRecipe(deployment);
  if (
    pinned.sourceRef === deployment.sourceRef &&
    JSON.stringify(pinned.installCfg) === JSON.stringify(deployment.installCfg)
  )
    return deployment;
  const updated = await db.deployment.updateMany({
    where: { ...where, updatedAt: deployment.updatedAt },
    data: {
      sourceRef: pinned.sourceRef,
      installCfg:
        pinned.installCfg === null
          ? Prisma.DbNull
          : (pinned.installCfg as Prisma.InputJsonValue),
    },
  });
  if (updated.count !== 1) throw new McpPinningError();
  const current = await db.deployment.findFirst({
    where,
    include: { server: true },
  });
  if (
    !current ||
    current.sourceRef !== pinned.sourceRef ||
    JSON.stringify(current.installCfg) !== JSON.stringify(pinned.installCfg)
  )
    throw new McpPinningError();
  return current;
}
