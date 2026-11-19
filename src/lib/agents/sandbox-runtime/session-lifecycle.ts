import "server-only";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { runTrackedDockerExec, SANDBOX_NODE_FLAG } from "./docker-exec";
import { removeSandboxFiles, writeSandboxFile } from "./materialization";

import {
  sandboxAgentHomeEnvironment,
  sandboxRuntimeStateRoot,
} from "../sandbox-runtime";
import { agentSessionWorkingDirectory } from "../session-paths";
import { sandboxContainerName } from "@/lib/sandboxes/runtime";
import type { AgentConversationSandbox } from "../conversation-sandbox";
import { PI_HOST_ENTRY } from "./pi-host-files";

export async function forkPiSessionInSandbox(
  input: {
    agentId: string;
    sourceConversationId: string;
    targetConversationId: string;
    entryId: string;
    workingDirectory?: string;
    signal?: AbortSignal;
  },
  source: AgentConversationSandbox,
  target: AgentConversationSandbox,
) {
  const root = sandboxRuntimeStateRoot(
    "pi-sdk",
    input.agentId,
    source.workspaceRoot,
  );
  const targetRoot = sandboxRuntimeStateRoot(
    "pi-sdk",
    input.agentId,
    target.workspaceRoot,
  );
  const hostPath = `${root}/host/tree-${randomUUID()}.mjs`;
  const container = sandboxContainerName(source.sandboxId);
  const request = {
    id: randomUUID(),
    type: "fork",
    entryId: input.entryId,
    target: {
      workspaceRoot: target.workspaceRoot,
      cwd: agentSessionWorkingDirectory(
        { conversationId: input.targetConversationId },
        input.workingDirectory,
      ),
      sessionsDir: `${targetRoot}/sessions/${input.targetConversationId}`,
      statePath: `${targetRoot}/sessions/${input.targetConversationId}.json`,
    },
  };
  try {
    await writeSandboxFile(
      container,
      hostPath,
      await readFile(`${process.cwd()}/scripts/${PI_HOST_ENTRY}`, "utf8"),
    );
    const output = await runTrackedDockerExec({
      container,
      workdir: source.workspaceRoot,
      executable: "node",
      args: [
        SANDBOX_NODE_FLAG,
        "--input-type=module",
        "-e",
        `
      import { spawn } from 'node:child_process';
      const child = spawn(process.execPath, [${JSON.stringify(SANDBOX_NODE_FLAG)}, ${JSON.stringify(hostPath)}, ${JSON.stringify(`${root}/host/${input.sourceConversationId}.json`)}], { stdio: ['pipe', 'ignore', 'ignore', 'pipe'] });
      let buffer = '', replied = false;
      child.stdio[3].on('data', chunk => {
        buffer += chunk;
        for (;;) {
          const end = buffer.indexOf('\\n');
          if (end < 0) break;
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          const event = JSON.parse(line);
          if (event.type === 'toolplane_sdk_response' && event.id === ${JSON.stringify(request.id)}) {
            replied = true; process.stdout.write(JSON.stringify(event)); child.stdin.end();
          }
        }
      });
      child.on('error', () => process.exitCode = 1);
      child.on('exit', () => { if (!replied) process.exitCode = 1; });
      child.stdin.write(${JSON.stringify(`${JSON.stringify(request)}\n`)});
    `,
      ],
      env: {
        ...sandboxAgentHomeEnvironment(),
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
      },
      signal: input.signal,
      timeoutMs: 30_000,
    });
    const response = JSON.parse(output);
    if (response.success !== true || response.result?.fork?.forked !== true)
      throw new Error(
        /^PI_[A-Z_]+$/.test(response.error?.code ?? "")
          ? response.error.code
          : "PI_SDK_FORK_FAILED",
      );
  } finally {
    await removeSandboxFiles(container, [hostPath]);
  }
}

export async function stopPiSessionInSandbox(
  container: string,
  workspaceRoot: string,
  stateRoot: string,
): Promise<void> {
  const driverPath = `${workspaceRoot}/.toolplane/runtime-tmp/${randomUUID()}-stop.mjs`;
  try {
    await writeSandboxFile(
      container,
      driverPath,
      await readFile(
        `${process.cwd()}/scripts/native-runtime-stop.mjs`,
        "utf8",
      ),
    );
    await runTrackedDockerExec({
      container,
      workdir: "/workspace",
      executable: "node",
      args: [driverPath, stateRoot],
      timeoutMs: 15_000,
    });
  } finally {
    await removeSandboxFiles(container, [driverPath]);
  }
}
