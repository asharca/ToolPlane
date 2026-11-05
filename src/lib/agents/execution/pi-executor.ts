import "server-only";
import { TaskState } from "@a2a-js/sdk";
import { runSandboxAgentTurn } from "@/lib/agents/sandbox-runtime";
import { drainRetiredPiHarnessTask } from "@/lib/agents/pi-harness";
import { A2A_LIMITS, textArtifact } from "@/lib/a2a/model";
import { assertLiveGrant } from "@/lib/a2a/principal";
import type { TaskGrant } from "@/lib/a2a/principal";
import { localTaskOptions } from "@/lib/agents/execution/task-options";
import type { TaskExecutor } from "@/lib/agents/execution/executor";
import { LOCAL_COLLABORATION_INSTRUCTIONS } from "@/lib/a2a/instructions";
import type {
  RuntimeCommand,
  RuntimeCommandResult,
  RuntimeUsage,
} from "@/lib/agents/runtime-commands";
import { isLocalGrant } from "@/lib/a2a/principal";
import { workRuntimeObserver } from "@/lib/work/run-control";

/** Local runtime port: Task context identity, not a private Conversation or old sub-agent runner. */
export const executeLocalTask: TaskExecutor = async (row, signal) => {
  if (row.executionBackend === "pi-harness")
    return drainRetiredPiHarnessTask(row, signal);
  if (row.executionBackend !== "pi-sdk")
    throw new Error("Unknown Agent execution backend.");
  const grant = row.grant as unknown as TaskGrant;
  const observer =
    isLocalGrant(grant) &&
    !grant.ancestorTaskIds.length &&
    grant.entryPolicy?.kind === "work"
      ? workRuntimeObserver(grant.entryPolicy.sourceId)
      : undefined;
  await observer?.onExecutionStage?.("preparing");
  const options = await localTaskOptions(
    row,
    signal,
    LOCAL_COLLABORATION_INSTRUCTIONS,
  );
  let commands: RuntimeCommand[] = [];
  let usage: RuntimeUsage | undefined;
  let commandResult: RuntimeCommandResult | undefined;
  const text = await runSandboxAgentTurn({
    ...options,
    onTextDelta: observer?.onTextDelta,
    onActivity: observer?.onActivity,
    onExecutionStage: observer?.onExecutionStage,
    onContextUsage: observer?.onContextUsage,
    onCommands: async (value) => {
      commands = value;
      await observer?.onCommands?.(value);
    },
    onUsage: async (value) => {
      usage = value;
      await observer?.onUsage?.(value);
    },
    onCommandResult: async (value) => {
      commandResult = value;
      await observer?.onCommandResult?.(value);
    },
  });
  signal.throwIfAborted();
  await assertLiveGrant(grant, "send");
  if (text.length > A2A_LIMITS.outputCharacters)
    throw new Error("Task output limit exceeded.");
  const artifact = textArtifact(text);
  if (options.runtimeKind === "pi-sdk")
    artifact.metadata = {
      toolplanePiSdk: {
        commands,
        model: { providerId: options.provider.id, model: options.modelId },
        ...(usage ? { usage } : {}),
        ...(commandResult ? { commandResult } : {}),
      },
    };
  return { state: TaskState.TASK_STATE_COMPLETED, artifact };
};
