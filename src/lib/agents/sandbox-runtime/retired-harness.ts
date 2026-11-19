import "server-only";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { runTrackedDockerExec } from "./docker-exec";
import { removeSandboxFiles, writeSandboxFile } from "./materialization";

const RUNTIME_TEMP_ROOT = "/workspace/.toolplane/runtime-tmp";

export type PiHarnessOperationResult = {
  status: "completed" | "declined" | "aborted" | "failed";
  text: string;
  operationId?: string;
};

export type PiHarnessBinding = {
  taskId: string;
  contextId: string;
  operationId: string;
};

export async function runRetiredHarnessDrain(
  container: string,
  options: { agentId: string; timeoutMs?: number },
  binding: PiHarnessBinding,
): Promise<PiHarnessOperationResult> {
  const id = randomUUID();
  const inputPath = `${RUNTIME_TEMP_ROOT}/${id}-cancel.json`;
  const hostPath = `${RUNTIME_TEMP_ROOT}/${id}-drain.mjs`;
  await writeSandboxFile(
    container,
    hostPath,
    await readFile(`${process.cwd()}/scripts/pi-harness-drain.mjs`, "utf8"),
  );
  try {
    await writeSandboxFile(
      container,
      inputPath,
      JSON.stringify({ ...binding, agentId: options.agentId }),
    );
    const output = await runTrackedDockerExec({
      container,
      workdir: "/workspace",
      executable: "node",
      args: [hostPath, inputPath],
      timeoutMs: options.timeoutMs ?? 15_000,
      env: { PI_OFFLINE: "1", PI_TELEMETRY: "0", NO_COLOR: "1" },
    });
    let result: PiHarnessOperationResult | undefined;
    for (const line of output.split("\n").filter(Boolean)) {
      const event = JSON.parse(line);
      result = z
        .object({
          status: z.enum(["completed", "declined", "aborted", "failed"]),
          text: z.string(),
          operationId: z.string().optional(),
        })
        .parse(event);
    }
    if (!result)
      throw new Error(
        "PI_PROTOCOL_ERROR: cancellation did not return a terminal result.",
      );
    return result;
  } finally {
    await removeSandboxFiles(container, [inputPath, hostPath]);
  }
}
