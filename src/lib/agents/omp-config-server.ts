import "server-only";
import {
  type WorkspaceScope,
  workspaceScopeWhere,
} from "@/lib/workspace/scope";
import { db } from "@/lib/db";
import { scanMarketArtifact } from "@/lib/pi-packages/secret-scan";

import {
  OmpConfigSnapshotSchema,
  isOmpInstructionPath,
  emptyOmpConfig,
} from "./omp-config";

export class OmpConfigError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(code);
  }
}
export function parseOmpConfigSnapshot(value: unknown) {
  const parsed = OmpConfigSnapshotSchema.safeParse(value);
  if (!parsed.success) throw new OmpConfigError("OMP_CONFIG_INVALID");
  if (scanMarketArtifact(parsed.data).status !== "passed")
    throw new OmpConfigError("OMP_CONFIG_CONTAINS_SECRET");
  return parsed.data;
}
/** Instruction files append to the primary Agent prompt, never replace it. */
export async function readOmpInstructions(
  scope: WorkspaceScope,
  agentId: string,
) {
  return db.$transaction(async (tx) => {
    const agent = await tx.agent.findFirst({
      where: {
        id: agentId,
        workspace: workspaceScopeWhere(scope),
        runtimeKind: "omp",
        publicRuntimeAllocation: null,
      },
    });
    if (!agent) throw new OmpConfigError("OMP_AGENT_NOT_FOUND", 404);
    const snapshot = parseOmpConfigSnapshot(
      agent.ompConfig ?? emptyOmpConfig(),
    );
    return {
      systemPrompt: agent.systemPrompt,
      files: snapshot.files
        .filter((file) => isOmpInstructionPath(file.path))
        .map((file) => ({ ...file, mode: "append" as const })),
    };
  });
}

export async function saveOmpInstructionsDraft(
  scope: WorkspaceScope,
  input: {
    agentId: string;
    files: unknown;
  },
) {
  const agent = await db.agent.findFirst({
    where: {
      id: input.agentId,
      workspace: workspaceScopeWhere(scope),
      runtimeKind: "omp",
    },
    select: { id: true },
  });
  if (!agent) throw new OmpConfigError("OMP_AGENT_NOT_FOUND", 404);
  throw new OmpConfigError("AGENT_EXECUTION_RETIRED", 410);
}
