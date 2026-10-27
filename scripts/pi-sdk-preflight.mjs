#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { materializePiPackageSnapshots } from "./pi-sdk-package-files.mjs";
import {
  enforceNativeNamespaces,
  PiCapabilityConflictError,
  assertNativeSkillDiagnostics,
} from "./pi-sdk-capabilities.mjs";
if (process.argv[2] !== "worker") {
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "worker"],
    {
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: "/tmp",
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
      },
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    },
  );
  let size = 0,
    result = "",
    failed = false;
  const stop = () => {
    failed = true;
    child.kill("SIGKILL");
  };
  const timer = setTimeout(stop, 20000);
  for (const stream of [child.stdout, child.stderr, child.stdio[3]])
    stream.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) stop();
    });
  child.stdio[3].on("data", (chunk) => {
    if (result.length < 128 * 1024) result += chunk;
    else stop();
  });
  process.stdin.pipe(child.stdin);
  child.on("error", stop);
  child.on("close", (code) => {
    clearTimeout(timer);
    if (failed || code !== 0) {
      process.stderr.write("PI_CAPABILITY_PREFLIGHT_FAILED\n");
      process.exitCode = 1;
    } else process.stdout.write(result);
  });
} else {
  let stage = "input";
  try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    const sdkRoot =
      "/opt/pi-sdk/node_modules/@earendil-works/pi-coding-agent/dist";
    const { loadExtensions } = await import(
      pathToFileURL(join(sdkRoot, "core/extensions/loader.js"))
    );
    const { loadSkills } = await import(
      pathToFileURL(join(sdkRoot, "core/skills.js"))
    );
    const { loadPromptTemplates } = await import(
      pathToFileURL(join(sdkRoot, "core/prompt-templates.js"))
    );
    const cwd = "/tmp/preflight";
    mkdirSync(cwd, { recursive: true });
    const packages = input.packages.map((item, i) => ({
      ...item,
      root: `${cwd}/packages/${i}/snapshot`,
      manifestPath: `${cwd}/packages/${i}/manifest.json`,
    }));
    stage = "package-materialization";
    materializePiPackageSnapshots(packages);
    const resources = { extensions: [], skills: [], prompts: [] };
    for (const item of packages)
      for (const kind of Object.keys(resources))
        resources[kind].push(
          ...item.manifest.package.resources[kind].map((path) =>
            join(item.root, path),
          ),
        );
    for (const bundle of input.skills) {
      const root = `${cwd}/skills/${bundle.directory}`;
      mkdirSync(root, { recursive: true });
      writeFileSync(`${root}/SKILL.md`, bundle.markdown);
      for (const file of bundle.files) {
        const path = resolve(root, file.path);
        if (!path.startsWith(`${root}/`) || file.path.includes("\\"))
          throw Error("PI_SKILL_PATH_INVALID");
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(
          path,
          file.encoding === "base64"
            ? Buffer.from(file.content, "base64")
            : file.content,
        );
      }
      resources.skills.push(root);
    }
    globalThis[Symbol.for("toolplane.pi.host-context.v1")] = {
      kind: "toolplane-sdk",
      platformMcp: true,
    };
    stage = "extension-loading";
    const extensions = await loadExtensions(resources.extensions, cwd);
    const skills = loadSkills({
      cwd,
      agentDir: cwd,
      skillPaths: resources.skills,
      includeDefaults: false,
    });
    const prompts = loadPromptTemplates({
      cwd,
      agentDir: cwd,
      promptPaths: resources.prompts,
      includeDefaults: false,
    });
    if (extensions.errors.length)
      throw new Error(JSON.stringify(extensions.errors).slice(0, 2048));
    stage = "native-namespaces";
    assertNativeSkillDiagnostics(skills.diagnostics);
    const result = enforceNativeNamespaces({
      extensions: extensions.extensions,
      skills: skills.skills,
      prompts: prompts.templates,
      hostCommands: input.hostCommands,
      toolNames: input.toolNames,
    });
    writeFileSync(3, JSON.stringify(result));
    process.exit(0);
  } catch (error) {
    writeFileSync(
      3,
      JSON.stringify({
        error:
          error instanceof PiCapabilityConflictError
            ? "PI_CAPABILITY_CONFLICT"
            : "PI_EXTENSION_LOAD_FAILED",
        detail:
          `${stage}: ${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            2048,
          ),
      }),
    );
    process.exit(0);
  }
}
