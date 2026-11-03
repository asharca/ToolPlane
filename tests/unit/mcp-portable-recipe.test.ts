// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { resolvePinnedMcpRecipe } from "@/lib/process/mcp-pinning";
import { assertSessionMcpRecipePinned } from "@/lib/process/mcp-definition";

describe("portable MCP recipes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    {
      command: "npx",
      args: ["-y", "@team/mcp", "--label", "two words"],
      expected: ["-y", "@team/mcp@1.2.3", "--label", "two words"],
    },
    {
      command: "npx",
      args: ["--package=@team/mcp", "mcp"],
      expected: ["--package=@team/mcp@1.2.3", "mcp"],
    },
    {
      command: "uvx",
      args: ["mcp-time", "--timezone", "UTC"],
      expected: ["mcp-time==1.2.3", "--timezone", "UTC"],
    },
    {
      command: "uv",
      args: ["tool", "run", "--from", "mcp-time", "--with=dependency", "mcp"],
      expected: [
        "tool",
        "run",
        "--from",
        "mcp-time==1.2.3",
        "--with=dependency==1.2.3",
        "mcp",
      ],
    },
  ])(
    "pins $command package selectors without changing executable arguments",
    async ({ command, args, expected }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({
            "dist-tags": { latest: "1.2.3" },
            info: { version: "1.2.3" },
          }),
        ),
      );
      const recipe = {
        source: "config",
        sourceRef: command,
        installCfg: { command, args, env: { TOKEN: "unchanged" } },
      };
      const pinned = await resolvePinnedMcpRecipe(recipe);
      expect(pinned.installCfg).toEqual({
        command,
        args: expected,
        env: { TOKEN: "unchanged" },
      });
      expect(recipe.installCfg.args).toEqual(args);
      expect(() =>
        assertSessionMcpRecipePinned({
          ...recipe,
          ...pinned,
          serverId: null,
          name: null,
        }),
      ).not.toThrow();
    },
  );

  it("keeps exact package versions and Git commits without registry access", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const [source, sourceRef] of [
      ["npm", "@team/mcp@1.2.3-beta.1"],
      ["pypi", "mcp-time[extra]==1.2.3"],
      ["github", `https://github.com/team/mcp#${"a".repeat(40)}`],
    ]) {
      expect(
        await resolvePinnedMcpRecipe({ source, sourceRef, installCfg: {} }),
      ).toEqual({ sourceRef, installCfg: {} });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves a floating GitHub repository to the default-branch commit", async () => {
    const fetchMock = vi.fn(async () => Response.json({ sha: "a".repeat(40) }));
    vi.stubGlobal("fetch", fetchMock);
    const pinned = await resolvePinnedMcpRecipe({
      source: "github",
      sourceRef: "https://github.com/team/mcp",
      installCfg: {},
    });
    expect(pinned.sourceRef).toBe(
      `https://github.com/team/mcp#${"a".repeat(40)}`,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/team/mcp/commits/HEAD",
      expect.objectContaining({
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it.each(["github:team/mcp", "team/mcp", "git+https://github.com/team/mcp"])(
    "pins npm GitHub selector %s",
    async (ref) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ sha: "a".repeat(40) })),
      );
      const pinned = await resolvePinnedMcpRecipe({
        source: "config",
        sourceRef: "npx",
        installCfg: { command: "npx", args: ["-y", ref] },
      });
      expect(pinned.installCfg).toEqual({
        command: "npx",
        args: ["-y", `https://github.com/team/mcp#${"a".repeat(40)}`],
      });
    },
  );

  it.each([
    { command: "uv", args: ["run", "--with", "mcp-time", "mcp"] },
    {
      command: "uvx",
      args: ["--from", "git+https://example.com/team/mcp@v1", "mcp"],
    },
    { command: "npx", args: ["git+https://example.com/team/mcp#v1"] },
  ])(
    "preserves nonregistry $command deployment recipes without bypassing the session boundary",
    async (installCfg) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const recipe = {
        source: "config",
        sourceRef: installCfg.command,
        installCfg,
      };
      expect(await resolvePinnedMcpRecipe(recipe)).toEqual({
        sourceRef: recipe.sourceRef,
        installCfg,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(() =>
        assertSessionMcpRecipePinned({ ...recipe, serverId: null, name: null }),
      ).toThrow("MCP_EXACT_PACKAGE_VERSION_REQUIRED");
    },
  );

  it("retains the immutable session boundary for floating selectors", () => {
    expect(() =>
      assertSessionMcpRecipePinned({
        source: "npm",
        sourceRef: "@team/mcp",
        installCfg: {},
        serverId: null,
        name: null,
      }),
    ).toThrow("MCP_EXACT_PACKAGE_VERSION_REQUIRED");
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
