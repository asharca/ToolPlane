import "server-only";
import {
  assertRuntimeOwner,
  trackRuntimeOperation,
  runtimeAbortSignal,
} from "@/lib/runtime/ownership-state";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  agentOptionalBuiltinTool,
  normalizeOptionalBuiltinTools,
} from "../runtime-kind";
import type { SkillForPrompt } from "../resolve";
import { parsePiPackageReleaseManifest } from "@/lib/pi-packages/manifest";
import { HOST_ONLY_COMMAND_NAMES } from "../runtime-commands";
import { z } from "zod";
import { prepareLspRuntime } from "../lsp-runtime";
import {
  PI_PACKAGE_CAPTURE_IMAGE,
  PI_DEBUGPY_CAPTURE_IMAGE,
} from "../pi-version";
import { dockerEnv, runDockerOnce } from "./docker-exec";
import {
  type RunSandboxAgentTurnOptions,
  waitForSandboxRuntimeInstall,
  buildSandboxSkillBundles,
} from "../sandbox-runtime";

export type PiSdkCapabilityInventory = {
  commands: string[];
  tools: string[];
  prompts: { name: string; path: string }[];
  skills: string[];
};

/** Module names come exclusively from the trusted registry, never a user path. */
export async function piOptionalBuiltinExtensionSources(
  names: readonly string[] | undefined,
) {
  const sources: { name: string; content: string }[] = [];
  for (const name of normalizeOptionalBuiltinTools(names)) {
    if (agentOptionalBuiltinTool(name)?.implementation !== "sandbox-extension")
      continue;
    if (!/^[a-z][a-z0-9_]*$/.test(name))
      throw new Error("OPTIONAL_BUILTIN_TOOLS_INVALID");
    sources.push({
      name,
      content: await readFile(
        `${process.cwd()}/scripts/pi-optional-tools/${name}.mjs`,
        "utf8",
      ),
    });
  }
  return sources;
}

let debugpyArtifact: Promise<string> | undefined;

/** Separate dependency artifact: never changes or replaces an installed SDK. */
export function prepareDebugpyArtifact(): Promise<string> {
  if (debugpyArtifact) return debugpyArtifact;
  debugpyArtifact = trackRuntimeOperation(async () => {
    assertRuntimeOwner(true);
    const name = `toolplane-debugpy-export-${randomUUID()}`;
    const signal = runtimeAbortSignal();
    const command = (args: string[], stdin?: string, timeoutMs = 60_000) => {
      assertRuntimeOwner(true);
      const { promise, resolve, reject } = Promise.withResolvers<string>();
      const child = execFile(
        "docker",
        args,
        {
          env: dockerEnv(),
          signal,
          timeout: timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
        },
        (error, stdout) =>
          error
            ? reject(new Error("DEBUG_DEPENDENCY_MISSING", { cause: error }))
            : resolve(stdout),
      );
      child.stdin?.end(stdin);
      return promise;
    };
    let created = false;
    try {
      // Provision the separately versioned companion image on old daemons too.
      // Only the daemon pulls; the subsequent export container remains offline.
      const present = await command([
        "image",
        "ls",
        "--quiet",
        "--no-trunc",
        PI_DEBUGPY_CAPTURE_IMAGE,
      ]);
      if (!present.trim())
        await command(["pull", PI_DEBUGPY_CAPTURE_IMAGE], undefined, 300_000);
      const imageId = (
        await command([
          "image",
          "inspect",
          PI_DEBUGPY_CAPTURE_IMAGE,
          "--format",
          "{{.Id}}",
        ])
      ).trim();
      if (!/^sha256:[a-f0-9]{64}$/.test(imageId))
        throw new Error("DEBUG_DEPENDENCY_MISSING");
      const source = await readFile(
        `${process.cwd()}/scripts/pi-debugpy-export.mjs`,
        "utf8",
      );
      await command([
        "create",
        "--name",
        name,
        "-i",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--memory",
        "256m",
        "--pids-limit",
        "32",
        "--entrypoint",
        "node",
        imageId,
        "--input-type=module",
        "-",
      ]);
      created = true;
      const raw = await command(
        ["start", "-ai", name],
        `${source}\nprocess.stdout.write(JSON.stringify(await exportDebugpy()));`,
      );
      const artifact = z
        .object({
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          data: z.string().max(12 * 1024 * 1024),
        })
        .strict()
        .parse(JSON.parse(raw));
      const bytes = Buffer.from(artifact.data, "base64");
      if (
        bytes.toString("base64") !== artifact.data ||
        createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
      )
        throw new Error("DEBUG_DEPENDENCY_MISSING");
      return JSON.stringify(artifact);
    } finally {
      if (created) await runDockerOnce(["rm", "-f", name]);
    }
  }).catch((error: unknown) => {
    debugpyArtifact = undefined;
    throw error;
  });
  return debugpyArtifact;
}

/** Executes native factories only inside the credential-free, offline capture image. */
export type PiSdkPreflightInput = {
  piPackages?: RunSandboxAgentTurnOptions["piPackages"];
  skills?: readonly SkillForPrompt[];
  toolNames?: readonly string[];
  optionalBuiltinTools?: readonly string[];
  signal?: AbortSignal;
};

export async function inspectPiSdkCapabilities(
  input: PiSdkPreflightInput,
  signal?: AbortSignal,
): Promise<PiSdkCapabilityInventory> {
  const name = `toolplane-pi-preflight-${randomUUID()}`;
  if (input.optionalBuiltinTools?.includes("lsp")) await prepareLspRuntime();
  const directory = await mkdtemp(`${tmpdir()}/toolplane-pi-preflight-`);
  const command = (args: string[], stdin?: string) =>
    new Promise<string>((resolve, reject) => {
      const child = execFile(
        "docker",
        args,
        { env: dockerEnv(), timeout: 30_000, maxBuffer: 1024 * 1024, signal },
        (error, stdout) =>
          error
            ? reject(
                new Error("PI_CAPABILITY_PREFLIGHT_FAILED", { cause: error }),
              )
            : resolve(stdout),
      );
      child.stdin?.end(stdin);
    });
  let created = false;
  try {
    const packages = (input.piPackages ?? []).map((item) => ({
      ...item,
      manifest: parsePiPackageReleaseManifest(item.manifest, item.checksum),
    }));
    await chmod(directory, 0o755);
    for (const source of [
      "pi-sdk-preflight.mjs",
      "pi-sdk-capabilities.mjs",
      "pi-sdk-package-files.mjs",
      "pi-sdk-native-resources.mjs",
    ]) {
      await writeFile(
        `${directory}/${source}`,
        await readFile(`${process.cwd()}/scripts/${source}`),
        { mode: 0o444 },
      );
    }
    const optionalBuiltinExtensions = [];
    for (const { name, content } of await piOptionalBuiltinExtensionSources(
      input.optionalBuiltinTools,
    )) {
      const path = `${directory}/optional-${name}.mjs`;
      await writeFile(path, content, { mode: 0o444 });
      if (name === "debug") {
        const artifact = await waitForSandboxRuntimeInstall(
          prepareDebugpyArtifact(),
          signal,
        );
        await writeFile(`${directory}/debugpy.artifact.json`, artifact, {
          mode: 0o444,
        });
      }
      optionalBuiltinExtensions.push(
        `/opt/toolplane-preflight/optional-${name}.mjs`,
      );
    }
    await command([
      "create",
      "--name",
      name,
      "-i",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--memory",
      "512m",
      "--cpus",
      "1",
      "--pids-limit",
      "64",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,mode=1777,size=256m",
      "--mount",
      `type=bind,source=${directory},target=/opt/toolplane-preflight,readonly`,
      "--entrypoint",
      "/usr/bin/env",
      PI_PACKAGE_CAPTURE_IMAGE,
      "-i",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "HOME=/tmp",
      "node",
      "/opt/toolplane-preflight/pi-sdk-preflight.mjs",
    ]);
    created = true;
    const output = await command(
      ["start", "-ai", name],
      JSON.stringify({
        packages,
        skills: buildSandboxSkillBundles(input.skills ?? []),
        toolNames: input.toolNames ?? [],
        hostCommands: HOST_ONLY_COMMAND_NAMES,
        optionalBuiltinExtensions,
      }),
    );
    const result: unknown = JSON.parse(output);
    const failure = z
      .object({
        error: z.enum(["PI_CAPABILITY_CONFLICT", "PI_EXTENSION_LOAD_FAILED"]),
        detail: z.string().max(2048).optional(),
      })
      .safeParse(result);
    if (failure.success)
      throw new Error(failure.data.error, {
        cause: failure.data.detail ? new Error(failure.data.detail) : undefined,
      });
    return z
      .object({
        commands: z.array(z.string()),
        tools: z.array(z.string()),
        skills: z.array(z.string()),
        prompts: z.array(z.object({ name: z.string(), path: z.string() })),
      })
      .parse(result);
  } finally {
    if (created) await runDockerOnce(["rm", "-f", name]);
    await rm(directory, { recursive: true, force: true });
  }
}
