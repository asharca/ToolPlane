import "server-only";
import { findAgentConversationSandbox } from "../conversation-sandbox";
import { db } from "@/lib/db";
import { effectiveStatus } from "@/lib/process/supervisor";
import { safeSkillFilePath } from "@/lib/skills/bundle";
import type { SkillForPrompt } from "../resolve";
import { z } from "zod";
import type { AgentSessionIdentity } from "../session-paths";
import { runTrackedDockerExec } from "./docker-exec";
import {
  buildSandboxSkillBundles,
  sandboxSkillBundleDigest,
  type RunSandboxAgentTurnOptions,
  sandboxRuntimeCanReachProxy,
  SANDBOX_TURN_PREPARER,
} from "../sandbox-runtime";

export async function writeSandboxFile(
  container: string,
  path: string,
  content: string | Buffer,
  signal?: AbortSignal,
): Promise<void> {
  const script = 'set -eu; umask 077; mkdir -p "$(dirname "$1")"; cat > "$1"';
  await runTrackedDockerExec({
    container,
    workdir: "/workspace",
    executable: "sh",
    args: ["-c", script, "toolplane-write", path],
    stdin: content,
    signal,
    timeoutMs: 30_000,
  });
}

/** Trusted sources and turn data cross stdin once; no sandbox marker authenticates host code. */

export type SandboxTurnPreparation = {
  files: { path: string; content: string; encoding?: "base64" }[];
  skillRoot: string;
  skills: readonly SkillForPrompt[];
  packages: unknown[];
  verifierPath: string;
  runtime: { kind: "pi-sdk"; directory: string; installerPath: string };
};

export async function prepareSandboxTurn(
  container: string,
  workspaceRoot: string,
  workdir: string,
  preparation: SandboxTurnPreparation,
  signal?: AbortSignal,
): Promise<boolean> {
  const bundles = buildSandboxSkillBundles(preparation.skills);
  const files: { path: string; content: string; encoding?: "base64" }[] = [];
  for (const bundle of bundles) {
    const root = `${preparation.skillRoot}/${bundle.directory}`;
    files.push({ path: `${root}/SKILL.md`, content: bundle.markdown });
    for (const file of bundle.files) {
      const path = safeSkillFilePath(file.path);
      if (path)
        files.push({
          path: `${root}/${path}`,
          content: file.content,
          encoding: file.encoding === "base64" ? "base64" : undefined,
        });
    }
  }
  const output = await runTrackedDockerExec({
    container,
    workdir: "/workspace",
    executable: "node",
    args: ["-e", SANDBOX_TURN_PREPARER],
    stdin: JSON.stringify({
      directories: [workspaceRoot, workdir],
      files: preparation.files,
      skills: {
        root: preparation.skillRoot,
        digest: sandboxSkillBundleDigest(bundles),
        files,
      },
      packages: preparation.packages,
      verifierPath: preparation.verifierPath,
      runtime: preparation.runtime,
    }),
    signal,
    timeoutMs: 120_000,
  });
  return z.object({ runtimeReady: z.boolean() }).parse(JSON.parse(output))
    .runtimeReady;
}

export async function removeSandboxFiles(
  container: string,
  paths: string[],
): Promise<void> {
  if (!paths.length) return;
  await runTrackedDockerExec({
    container,
    workdir: "/workspace",
    executable: "rm",
    args: ["-f", "--", ...paths],
    timeoutMs: 10_000,
  }).catch(() => undefined);
}

export async function assertAssignedDockerSandbox(
  options: Pick<
    RunSandboxAgentTurnOptions,
    "workspaceId" | "agentId" | "sandboxId" | "conversationId" | "a2aContextId"
  >,
  cleanup = false,
): Promise<{
  deploymentId: string;
  workspaceRoot?: string;
  identity?: AgentSessionIdentity;
}> {
  if (options.conversationId || options.a2aContextId) {
    const mapped = await findAgentConversationSandbox({
      workspaceId: options.workspaceId,
      agentId: options.agentId,
      conversationId: options.conversationId,
      contextId: options.a2aContextId,
      cleanup,
    });
    if (!mapped || mapped.sandboxId !== options.sandboxId)
      throw new Error("The sandbox does not match this conversation/context.");
    const sandbox = await db.sandbox.findFirst({
      where: {
        id: mapped.sandboxId,
        workspaceId: options.workspaceId,
        kind: "docker",
      },
      select: {
        network: true,
        deploymentId: true,
        deployment: { select: { status: true } },
      },
    });
    if (
      !sandbox ||
      !sandboxRuntimeCanReachProxy(sandbox.network) ||
      effectiveStatus(sandbox.deploymentId, sandbox.deployment.status) !==
        "running"
    )
      throw new Error("The conversation sandbox is not ready.");
    return {
      deploymentId: sandbox.deploymentId,
      workspaceRoot: mapped.workspaceRoot,
      identity: {
        conversationId: mapped.conversationId ?? options.conversationId,
        a2aContextId: mapped.contextId ?? options.a2aContextId,
      },
    };
  }
  const link = await db.agentSandbox.findUnique({
    where: {
      agentId_sandboxId: {
        agentId: options.agentId,
        sandboxId: options.sandboxId,
      },
    },
    select: {
      agent: { select: { workspaceId: true } },
      sandbox: {
        select: {
          id: true,
          workspaceId: true,
          kind: true,
          network: true,
          deploymentId: true,
          deployment: { select: { status: true } },
        },
      },
    },
  });
  if (
    !link ||
    link.agent.workspaceId !== options.workspaceId ||
    link.sandbox.workspaceId !== options.workspaceId
  ) {
    throw new Error("The sandbox is not assigned to this Agent.");
  }
  if (link.sandbox.kind !== "docker")
    throw new Error(
      "Pi, Claude Code, and DeepSeek Harness require a Docker sandbox.",
    );
  if (!sandboxRuntimeCanReachProxy(link.sandbox.network)) {
    throw new Error(
      "The assigned Docker sandbox has networking disabled and cannot reach the model proxy.",
    );
  }
  if (
    effectiveStatus(
      link.sandbox.deploymentId,
      link.sandbox.deployment.status,
    ) !== "running"
  ) {
    throw new Error("The assigned Docker sandbox is not running.");
  }
  return { deploymentId: link.sandbox.deploymentId };
}
