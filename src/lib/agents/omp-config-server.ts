import "server-only";
import { db } from "@/lib/db";
import { scanMarketArtifact } from "@/lib/pi-packages/secret-scan";
import { requirePluginWorkspace } from "@/lib/plugins/catalog";
import { withAgentDraftLease } from "./agent-execution-gate";
import {
  OmpConfigSnapshotSchema,
  OmpInstructionFilesSchema,
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
  workspaceId: string,
  userId: string,
  agentId: string,
) {
  return db.$transaction(async (tx) => {
    await requirePluginWorkspace(workspaceId, userId, false, tx);
    const agent = await tx.agent.findFirst({
      where: {
        id: agentId,
        workspaceId,
        runtimeKind: "omp",
        retiredAt: null,
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

export async function saveOmpInstructionsDraft(input: {
  workspaceId: string;
  userId: string;
  agentId: string;
  files: unknown;
}) {
  const parsed = OmpInstructionFilesSchema.safeParse(input.files);
  if (!parsed.success) throw new OmpConfigError("OMP_INSTRUCTIONS_INVALID");
  return withAgentDraftLease(input.agentId, () =>
    db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Agent" WHERE id=${input.agentId} AND "workspaceId"=${input.workspaceId} FOR UPDATE`;
      await requirePluginWorkspace(input.workspaceId, input.userId, false, tx);
      const agent = await tx.agent.findFirst({
        where: {
          id: input.agentId,
          workspaceId: input.workspaceId,
          runtimeKind: "omp",
          retiredAt: null,
          publicRuntimeAllocation: null,
        },
      });
      if (!agent) throw new OmpConfigError("OMP_AGENT_NOT_FOUND", 404);
      const snapshot = parseOmpConfigSnapshot(
        agent.ompConfig ?? emptyOmpConfig(),
      );
      const config = parseOmpConfigSnapshot({
        ...snapshot,
        files: [
          ...snapshot.files.filter((file) => !isOmpInstructionPath(file.path)),
          ...parsed.data,
        ],
      });
      await tx.agent.update({
        where: { id: agent.id },
        data: { ompConfig: config },
      });
      return { saved: true as const };
    }),
  );
}
