// @vitest-environment node
import { describe, expect, it } from "vitest";
import { assertPortableMcpRecipe } from "@/lib/market/mcp-portable-recipe";
import {
  parseServerRecipe,
  recipeToDeploymentData,
  type ServerRecipe,
} from "@/lib/workspace/server-recipe";
import { resolveSpawnSpec } from "@/lib/process/spawn-spec";
import { isValidMcpRef, parseMcpJsonConfig } from "@/lib/workspace/custom-mcp";
import {
  isValidDockerImageRef,
  parseDockerJsonArgs,
} from "@/lib/workspace/docker-json-command";

describe("portable MCP recipes", () => {
  it.each([
    ["npm", "pkg"],
    ["npm", "pkg@latest"],
    ["pypi", "pkg"],
    ["github", "https://github.com/team/repo#main"],
    ["docker", "example/mcp:latest"],
  ])("rejects mutable %s package %s", (source, ref) => {
    expect(() =>
      assertPortableMcpRecipe({ source, ref, env: [] } as ServerRecipe),
    ).toThrow();
  });
  it.each([
    ["npx", ["-c", "echo unsafe"]],
    ["npx", ["-y", "pkg@latest"]],
    ["uv", ["run", "script.py"]],
    ["uvx", ["--with", "dependency", "pkg==1.2.3"]],
    ["docker", ["run", "--privileged", "example/mcp:latest"]],
    ["npx", ["pkg@1.2.3", "--package", "other@latest"]],
    ["npx", ["pkg@1.2.3", "--", "--package=other@latest"]],
    ["npx", ["pkg@1.2.3", "-pother@latest"]],
    ["npx", ["pkg@1.2.3", "--call=sh"]],
    ["uvx", ["pkg==1.2.3", "--with", "other"]],
    ["uvx", ["pkg==1.2.3", "--with=other"]],
    ["uvx", ["pkg==1.2.3", "--with-requirements", "requirements.txt"]],
    ["uvx", ["pkg==1.2.3", "--with-executables-from=other"]],
    ["npx", ["pkg@1.2.3", "--pack=other@latest"]],
    ["uv", ["tool", "run", "pkg==1.2.3", "--from", "other"]],
    ["uvx", [`git+https://127.0.0.1/repo.git#${"a".repeat(40)}`]],
    ["uvx", [`git+https://unreviewed.example/repo.git#${"a".repeat(40)}`]],
  ])("rejects nonportable %s command options", (command, args) => {
    expect(() =>
      assertPortableMcpRecipe({
        source: "config",
        ref: command,
        command,
        args,
        env: [],
      } as ServerRecipe),
    ).toThrow();
  });
  it("round-trips JSON argv and launches only through the hardened Docker bridge", () => {
    const recipe = parseServerRecipe({
      source: "config",
      ref: "npx",
      command: "npx",
      args: ["-y", "@team/mcp@1.2.3", "--label", "two words"],
      env: ["TOKEN"],
    });
    expect(recipe).not.toBeNull();
    if (!recipe) throw new Error("Expected parsed recipe");
    assertPortableMcpRecipe(recipe);
    const data = recipeToDeploymentData(recipe);
    expect(data.installCfg).toMatchObject({
      command: "npx",
      args: recipe.args,
      env: { TOKEN: "" },
      requiredEnv: ["TOKEN"],
    });
    const spec = resolveSpawnSpec({ ...data, serverId: null, name: "MCP" });
    expect(spec.kind).toBe("bridge");
    if (spec.kind !== "bridge") throw new Error("Expected bridge");
    expect(spec.command).toBe("docker");
    expect(spec.args).toContain("--read-only");
    expect(spec.args.slice(-5)).toEqual([
      "npx",
      "-y",
      "@team/mcp@1.2.3",
      "--label",
      "two words",
    ]);
  });
  it("retains the sandbox network policy for pinned Git fetches", () => {
    const recipe: ServerRecipe = {
      source: "config",
      ref: "uvx",
      command: "uvx",
      args: [
        "--from",
        `git+https://github.com/team/repo.git#${"a".repeat(40)}`,
        "mcp",
      ],
      network: "none",
      env: [],
    };
    assertPortableMcpRecipe(recipe);
    const data = recipeToDeploymentData(recipe);
    const spec = resolveSpawnSpec({ ...data, serverId: null, name: "Git MCP" });
    if (spec.kind !== "bridge") throw new Error("Expected bridge");
    expect(
      spec.args.slice(
        spec.args.indexOf("--network"),
        spec.args.indexOf("--network") + 2,
      ),
    ).toEqual(["--network", "none"]);
    expect(spec.args).not.toContain("--network=host");
    expect(spec.image).toBe("ghcr.io/astral-sh/uv:python3.13-bookworm");
  });
  it.each([
    "example/mcp",
    "ghcr.io/team/mcp:stable",
    "registry.example:5000/team/mcp",
  ])(
    "preserves %s digests across direct and JSON recipe spawn",
    (repository) => {
      const image = `${repository}@sha256:${"a".repeat(64)}`;
      expect(isValidDockerImageRef(image)).toBe(true);
      expect(isValidMcpRef("docker", image)).toBe(true);
      expect(
        parseDockerJsonArgs(["run", "-i", "--rm", image, "--stdio"]),
      ).toEqual({ image, commandArgs: ["--stdio"] });
      const parsed = parseMcpJsonConfig(
        JSON.stringify({
          command: "docker",
          args: ["run", "-i", image, "--stdio"],
        }),
      );
      expect(parsed.installCfg).toMatchObject({
        command: "docker",
        args: ["run", "-i", image, "--stdio"],
      });
      for (const recipe of [
        parseServerRecipe({ source: "docker", ref: image, env: [] }),
        parseServerRecipe({
          source: "config",
          ref: "docker",
          command: "docker",
          args: ["run", "-i", image, "--stdio"],
          env: [],
        }),
      ]) {
        if (!recipe) throw new Error("Expected digest recipe");
        assertPortableMcpRecipe(recipe);
        const spec = resolveSpawnSpec({
          ...recipeToDeploymentData(recipe),
          serverId: null,
          name: "Digest MCP",
        });
        if (spec.kind !== "bridge") throw new Error("Expected Docker bridge");
        expect(spec.image).toBe(image);
        expect(spec.args).toContain(image);
        expect(spec.args).toContain("--read-only");
      }
    },
  );
  it.each([
    "example/mcp@sha256:short",
    `example/mcp@sha256:${"g".repeat(64)}`,
    `example/mcp@sha256:${"a".repeat(65)}`,
    `example/mcp@sha256:${"a".repeat(64)} --privileged`,
    `--privileged@sha256:${"a".repeat(64)}`,
    `https://registry.example/mcp@sha256:${"a".repeat(64)}`,
  ])("rejects malformed and argument-shaped digest %s", (image) => {
    expect(isValidDockerImageRef(image)).toBe(false);
    expect(isValidMcpRef("docker", image)).toBe(false);
    expect(
      parseServerRecipe({ source: "docker", ref: image, env: [] }),
    ).toBeNull();
    expect(() => parseDockerJsonArgs(["run", image])).toThrow();
  });
});
