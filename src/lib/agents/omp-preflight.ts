import "server-only";
import { execFile } from "node:child_process";
import { mkdtemp, chmod, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { prepareOmpRuntime } from "./omp-runtime";
import {
  assertRuntimeOwner,
  runtimeAbortSignal,
  trackRuntimeOperation,
} from "@/lib/runtime/ownership-state";
import type { ResolvedAgentPiPackage, SkillForPrompt } from "./resolve";
import {
  buildInstalledSkillMarkdown,
  installedSkillExtraFiles,
} from "@/lib/skills/artifact";
function dockerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV };
  for (const key of [
    "PATH",
    "HOME",
    "DOCKER_HOST",
    "DOCKER_CERT_PATH",
    "DOCKER_TLS_VERIFY",
    "LANG",
    "LC_ALL",
  ])
    if (process.env[key]) env[key] = process.env[key];
  return env;
}
/** Real pinned OMP startup and plugin factories, offline with no credentials or host filesystem access. */
export async function preflightOmpCapabilities(input: {
  piPackages: ResolvedAgentPiPackage[];
  skills: readonly SkillForPrompt[];
  toolNames?: string[];
}) {
  return trackRuntimeOperation(async () => {
    assertRuntimeOwner(true);
    const path = await prepareOmpRuntime();
    const root = await mkdtemp(`${tmpdir()}/toolplane-omp-preflight-`);
    const name = `toolplane-omp-preflight-${randomUUID()}`;
    const command = (args: string[], stdin?: string, teardown = false) => {
      const { promise, resolve, reject } = Promise.withResolvers<string>();
      const child = execFile(
        "docker",
        args,
        {
          env: dockerEnvironment(),
          timeout: teardown ? 10_000 : 60_000,
          maxBuffer: 1024 * 1024,
          signal: teardown ? undefined : runtimeAbortSignal(),
        },
        (error, stdout) =>
          error
            ? reject(
                new Error("OMP_CAPABILITY_PREFLIGHT_FAILED", { cause: error }),
              )
            : resolve(stdout),
      );
      child.stdin?.end(stdin);
      return promise;
    };
    let created = false;
    try {
      await chmod(root, 0o755);
      for (const source of [
        "omp-preflight.mjs",
        "omp-capabilities.mjs",
        "omp-hooks.mjs",
        "omp-ui.mjs",
        "omp-rpc.mjs",
        "pi-sdk-package-files.mjs",
      ])
        await writeFile(
          `${root}/${source}`,
          await readFile(`${process.cwd()}/scripts/${source}`),
          { mode: 0o444 },
        );
      created = true;
      // OMP extracts its checksum-pinned native addon beneath HOME in /tmp.
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
        "/tmp:rw,exec,nosuid,nodev,mode=1777,size=256m",
        "--mount",
        `type=bind,source=${root},target=/opt/preflight,readonly`,
        "--mount",
        `type=bind,source=${path},target=/opt/omp,readonly`,
        "--entrypoint",
        "/usr/bin/env",
        "toolplane-pi-package-capture:0.87.1",
        "-i",
        "PATH=/usr/local/bin:/usr/bin:/bin",
        "HOME=/tmp",
        "node",
        "/opt/preflight/omp-preflight.mjs",
      ]);
      const output = await command(
        ["start", "-ai", name],
        JSON.stringify({
          packages: input.piPackages,
          skills: input.skills.map((skill, i) => ({
            directory: `skill-${i}`,
            markdown: buildInstalledSkillMarkdown(skill),
            files: installedSkillExtraFiles(skill),
          })),
          toolNames: input.toolNames ?? [],
        }),
      );
      const result: unknown = JSON.parse(output);
      if (
        !result ||
        typeof result !== "object" ||
        !("ok" in result) ||
        result.ok !== true
      )
        throw new Error("OMP_CAPABILITY_PREFLIGHT_FAILED");
    } finally {
      try {
        if (created) await command(["rm", "-f", name], undefined, true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }, true);
}
