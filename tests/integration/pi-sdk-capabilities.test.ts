// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function load(sources: string[]) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-native-namespaces-"));
  roots.push(cwd);
  const paths = await Promise.all(
    sources.map(async (source, i) => {
      const path = join(cwd, `${i}.mjs`);
      await writeFile(path, source);
      return path;
    }),
  );
  const sdk = dirname(
    fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
  );
  // Exercise the installed native plugin loader boundary, outside Vitest's module transform.
  const { loadExtensions } = await import(
    pathToFileURL(join(sdk, "core/extensions/loader.js")).href
  );
  const loaded = await loadExtensions(paths, cwd);
  expect(loaded.errors).toEqual([]);
  // Load the executable sandbox artifact exactly as Node does, outside Vitest's transform.
  const { enforceNativeNamespaces } = await import(
    pathToFileURL(resolve("scripts/pi-sdk-capabilities.mjs")).href
  );
  return { loaded, enforceNativeNamespaces };
}
describe("native Pi capability namespaces", () => {
  it("retains typed conflict identity for duplicate names reported by the real Skill loader", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-native-skill-collision-"));
    roots.push(cwd);
    const skillPaths = [join(cwd, "first"), join(cwd, "second")];
    for (const directory of skillPaths) {
      await mkdir(directory);
      await writeFile(
        join(directory, "SKILL.md"),
        "---\nname: repeated-native-skill\ndescription: Duplicate namespace regression\n---\nUse this Skill.\n",
      );
    }
    const sdk = dirname(
      fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
    );
    const { loadSkills } = await import(
      pathToFileURL(join(sdk, "core/skills.js")).href
    );
    const { assertNativeSkillDiagnostics, PiCapabilityConflictError } =
      await import(
        pathToFileURL(resolve("scripts/pi-sdk-capabilities.mjs")).href
      );
    const loaded = loadSkills({
      cwd,
      agentDir: cwd,
      skillPaths,
      includeDefaults: false,
    });
    expect(
      loaded.diagnostics.some(
        (item: { type: string }) => item.type === "collision",
      ),
    ).toBe(true);
    let failure: unknown;
    try {
      assertNativeSkillDiagnostics(loaded.diagnostics);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(PiCapabilityConflictError);
    expect(failure).toMatchObject({ code: "PI_CAPABILITY_CONFLICT" });
  });
  it("accepts computed native command names without rewriting extensions", async () => {
    const { loaded, enforceNativeNamespaces } = await load([
      `export default (pi) => pi.registerCommand(["native", "command"].join("-"), {handler: async () => {}});`,
    ]);
    expect(
      enforceNativeNamespaces({
        extensions: loaded.extensions,
        skills: [],
        prompts: [],
      }).commands,
    ).toContain("native-command");
  });
  it("reserves actual generated MCP tool names, not external wire names", async () => {
    const nativeName = "mcp__s1_t1__search";
    const { loaded, enforceNativeNamespaces } = await load([
      `export default (pi) => pi.registerTool({ name: "search", parameters: {}, execute: async () => ({content:[]}) });`,
    ]);
    // The wire tool named search is exposed to Pi under a generated native name.
    expect(
      enforceNativeNamespaces({
        extensions: loaded.extensions,
        skills: [],
        prompts: [],
        toolNames: [nativeName],
      }).tools,
    ).toEqual(expect.arrayContaining(["search", nativeName]));
    const collision = await load([
      `export default (pi) => pi.registerTool({ name: "${nativeName}", parameters: {}, execute: async () => ({content:[]}) });`,
    ]);
    expect(() =>
      collision.enforceNativeNamespaces({
        extensions: collision.loaded.extensions,
        skills: [],
        prompts: [],
        toolNames: [nativeName],
      }),
    ).toThrow("PI_CAPABILITY_CONFLICT");
  });
  it("rejects native extension collisions with prompts and builtins", async () => {
    const { loaded, enforceNativeNamespaces } = await load([
      `export default (pi) => pi.registerCommand("review", {handler: async () => {}});`,
    ]);
    expect(() =>
      enforceNativeNamespaces({
        extensions: loaded.extensions,
        skills: [],
        prompts: [{ name: "review" }],
      }),
    ).toThrow("PI_CAPABILITY_CONFLICT");
    const builtin = await load([
      `export default (pi) => pi.registerTool({ name: "read", parameters: {}, execute: async () => ({content:[]}) });`,
    ]);
    expect(() =>
      builtin.enforceNativeNamespaces({
        extensions: builtin.loaded.extensions,
        skills: [],
        prompts: [],
      }),
    ).toThrow("PI_CAPABILITY_CONFLICT");
  });
  it("rejects later native registration against an existing extension namespace", async () => {
    const { loaded, enforceNativeNamespaces } = await load([
      `export default (pi) => pi.registerCommand("claimed", {handler: async () => {}});`,
      `export default (pi) => pi.on("session_start", () => pi.registerCommand("claimed", {handler: async () => {}}));`,
    ]);
    enforceNativeNamespaces({
      extensions: loaded.extensions,
      skills: [],
      prompts: [],
    });
    expect(() =>
      loaded.extensions[1].handlers.get("session_start")[0](),
    ).toThrow("PI_CAPABILITY_CONFLICT");
  });
});
