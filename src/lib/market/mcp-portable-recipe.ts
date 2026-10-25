import { parseDockerJsonArgs } from "@/lib/workspace/docker-json-command";
import type { ServerRecipe } from "@/lib/workspace/server-recipe";
import { serializeMcpJsonConfig } from "@/lib/workspace/custom-mcp";

const NPM_PIN =
  /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PYPI_PIN =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9_,.-]+\])?==\d+(?:\.\d+)*(?:[A-Za-z0-9.-]+)?$/;
const GIT_PIN =
  /^(?:https:\/\/github\.com\/|git\+https:\/\/github\.com\/)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?#[a-fA-F0-9]{40}$/;
const IMAGE_PIN = /@sha256:[a-fA-F0-9]{64}$/;

/** Pin the recipe's direct packages; registry dependencies and wrapper images are not byte-locked. */
export function assertPortableMcpRecipe(recipe: ServerRecipe): void {
  if (recipe.source === "remote") return;
  if (recipe.source !== "config") {
    const pinned =
      recipe.source === "npm"
        ? NPM_PIN.test(recipe.ref)
        : recipe.source === "pypi"
          ? PYPI_PIN.test(recipe.ref)
          : recipe.source === "github"
            ? GIT_PIN.test(recipe.ref)
            : IMAGE_PIN.test(recipe.ref);
    if (!pinned)
      throw new Error(
        "Marketplace MCP packages require an exact version, Git commit, or Docker sha256 digest.",
      );
    return;
  }
  const args = [...(recipe.args ?? [])];
  const masked = JSON.parse(
    serializeMcpJsonConfig(
      { command: recipe.command, args },
      { includeEnv: false },
    ),
  ) as { args: string[] };
  if (JSON.stringify(masked.args) !== JSON.stringify(args))
    throw new Error(
      "Portable MCP arguments cannot contain credentials; use required environment variables.",
    );
  if (recipe.command === "docker") {
    if (!IMAGE_PIN.test(parseDockerJsonArgs(args).image))
      throw new Error("Marketplace Docker MCPs require a sha256 digest.");
    return;
  }
  const npm = recipe.command === "npx";
  if (!npm && recipe.command !== "uvx" && recipe.command !== "uv")
    throw new Error("Unsupported portable MCP command.");
  if (
    recipe.command === "uv" &&
    (args.shift() !== "tool" || args.shift() !== "run")
  )
    throw new Error("Portable uv recipes must use uv tool run.");
  let packageSelected = false;
  let executableSelected = false;
  while (args.length) {
    const arg = args.shift() ?? "";
    if (executableSelected) {
      // Reserved runner options are rejected even as server arguments: runner
      // parsers differ on whether late options or separators are forwarded.
      if (
        /^(?:--(?:pack[a-z-]*|from[a-z-]*|with[a-z-]*|call|eval|node-options|config-file|directory|project|python(?:-preference|-downloads)?|index[a-z-]*|extra-index-url|default-index|find-links|script|module|registry|userconfig|npm|cache|refresh-package)(?:=|$)|-[pc])/.test(
          arg,
        )
      ) {
        throw new Error(
          "Portable MCP runner options must precede the executable and select pinned packages.",
        );
      }
      continue;
    }
    if (["-y", "--yes", "--no-cache", "--isolated"].includes(arg)) continue;
    if (arg === "--") continue;
    if (
      ["-p", "--package", "--from", "--with"].includes(arg) ||
      /^(?:--package|--from|--with)=/.test(arg)
    ) {
      const value = arg.includes("=")
        ? arg.slice(arg.indexOf("=") + 1)
        : (args.shift() ?? "");
      if (
        !(npm
          ? NPM_PIN.test(value)
          : PYPI_PIN.test(value) || GIT_PIN.test(value))
      )
        throw new Error("Portable MCP dependencies must be pinned.");
      if (arg !== "--with" && !arg.startsWith("--with="))
        packageSelected = true;
      continue;
    }
    if (arg.startsWith("-"))
      throw new Error("Unsupported portable package-runner option.");
    if (
      packageSelected ||
      (npm ? NPM_PIN.test(arg) : PYPI_PIN.test(arg) || GIT_PIN.test(arg))
    ) {
      executableSelected = true;
      continue;
    }
    throw new Error("Portable MCP executable must select a pinned package.");
  }
  if (!executableSelected)
    throw new Error("Portable MCP recipe has no executable.");
}
