import "server-only";
import {
  Artifact,
  Part as StandardPart,
  StreamResponse,
  Task,
  TaskState,
  SendMessageRequest,
} from "@a2a-js/sdk";
import {
  TaskNotFoundError,
  RequestMalformedError,
  UnsupportedOperationError,
} from "@a2a-js/sdk/errors";
import { db } from "@/lib/db";
import {
  A2A_LIMITS,
  acceptsOutput,
  artifactDigest,
  stampArtifactProvenance,
} from "./model";
import { isLocalGrant, type TaskGrant } from "./principal";
import { assertLocalGrant } from "./local-policy";
import { lockTask, persist } from "./store";
import {
  makeTaskFilePart,
  listTaskFiles,
  storeTaskFile,
  type TaskFile,
} from "./files";
import { storeSandboxTaskFile } from "./local-sandbox";
import { LocalArtifactInput } from "@/lib/agents/execution/tool-inputs";

export const LOCAL_ARTIFACT_BYTES = A2A_LIMITS.publishArtifactBytes;

export function parseLocalArtifact(raw: unknown): Artifact {
  const value = LocalArtifactInput.parse(raw);
  if (value.parts.some((part) => "path" in part || "fileId" in part))
    throw new RequestMalformedError(
      "File sources must be resolved by the authorized runtime.",
    );
  let bytes = 0;
  for (const part of value.parts) {
    if (!("text" in part || "data" in part || "raw" in part))
      throw new RequestMalformedError("Unresolved file source.");
    if (
      part.metadata?.toolplaneFileId !== undefined ||
      part.data?.toolplaneFileId !== undefined
    )
      throw new RequestMalformedError(
        "Use an owned fileId source instead of constructing an internal file reference.",
      );
    if (part.raw !== undefined) {
      if (
        !part.mediaType ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          part.raw,
        )
      )
        throw new RequestMalformedError(
          "File bytes must be canonical base64 with a mediaType.",
        );
      const content = Buffer.from(part.raw, "base64");
      if (content.toString("base64") !== part.raw)
        throw new RequestMalformedError("Non-canonical file bytes.");
      bytes += content.length;
    } else if (part.data !== undefined) {
      if (part.mediaType && part.mediaType !== "application/json")
        throw new RequestMalformedError(
          "Structured data must have application/json mediaType.",
        );
      part.mediaType = "application/json";
      bytes += Buffer.byteLength(JSON.stringify(part.data), "utf8");
    } else {
      if (part.text === undefined)
        throw new RequestMalformedError("Artifact text is required.");
      bytes += Buffer.byteLength(part.text, "utf8");
      part.mediaType ??= "text/plain";
    }
  }
  if (bytes > LOCAL_ARTIFACT_BYTES)
    throw new UnsupportedOperationError("Artifact content exceeds 32 KiB.");
  return Artifact.fromJSON(value);
}

/** Publish a standard, bounded Artifact to the caller-owned native task, never an arbitrary path or URL. */
export async function publishLocalArtifact(
  taskId: string,
  lease: string,
  raw: unknown,
) {
  const input = LocalArtifactInput.parse(raw);
  const inline = input.parts.filter(
    (part) => !("fileId" in part || "path" in part),
  );
  const validatedParts = inline.length
    ? parseLocalArtifact({ ...input, parts: inline }).parts
    : [];
  let inlineIndex = 0;
  const resolved = [];
  const fileSizes = new Map<string, number>();
  for (const [index, part] of input.parts.entries()) {
    if (
      !("fileId" in part || "path" in part) &&
      !("raw" in part && part.raw !== undefined)
    ) {
      resolved.push(StandardPart.toJSON(validatedParts[inlineIndex++]));
      continue;
    }
    const row = await db.a2ATask.findUniqueOrThrow({ where: { id: taskId } });
    const grant = row.grant as unknown as TaskGrant;
    if (
      !isLocalGrant(grant) ||
      row.state !== TaskState.TASK_STATE_WORKING ||
      row.phase !== "executing" ||
      row.leaseToken !== lease ||
      row.cancelRequestedAt ||
      row.pendingQuestion ||
      row.waitForTaskIds.length ||
      row.deadlineAt <= new Date()
    )
      throw new TaskNotFoundError();
    await assertLocalGrant(grant);
    let file: TaskFile | undefined;
    if ("raw" in part && part.raw !== undefined) {
      const inlinePart = validatedParts[inlineIndex++];
      const rawBytes = part.raw;
      file = await storeTaskFile(
        taskId,
        `artifact:${input.artifactId}:${index}`,
        part.filename ?? `${input.artifactId}-${index}.bin`,
        inlinePart.mediaType,
        (async function* () {
          yield Buffer.from(rawBytes, "base64");
        })(),
      );
    } else if ("fileId" in part || "path" in part) {
      if (part.fileId) {
        file = (await listTaskFiles(taskId)).find(
          (file) => file.id === part.fileId,
        );
      } else if (part.path) {
        file = await storeSandboxTaskFile(
          row,
          `artifact:${input.artifactId}:${index}`,
          part.path,
          part.filename,
          part.mediaType,
        );
      }
    }
    if (!file) throw new TaskNotFoundError();
    fileSizes.set(file.id, file.size);
    resolved.push(StandardPart.toJSON(makeTaskFilePart(file)));
  }
  const artifact = Artifact.fromJSON({ ...input, parts: resolved });
  return db.$transaction(async (tx) => {
    const row = await lockTask(tx, taskId);
    const grant = row.grant as unknown as TaskGrant;
    if (
      !isLocalGrant(grant) ||
      row.state !== TaskState.TASK_STATE_WORKING ||
      row.phase !== "executing" ||
      row.leaseToken !== lease ||
      row.cancelRequestedAt ||
      row.pendingQuestion ||
      row.waitForTaskIds.length ||
      row.deadlineAt <= new Date()
    )
      throw new TaskNotFoundError();
    await assertLocalGrant(grant, tx);
    const task = Task.fromJSON(row.snapshot);
    const modes =
      SendMessageRequest.fromJSON(row.request).configuration
        ?.acceptedOutputModes ?? [];
    if (
      artifact.parts.some(
        (part) => !acceptsOutput(modes, part.mediaType || "text/plain"),
      )
    )
      throw new UnsupportedOperationError(
        "Artifact mediaType was not accepted by the caller.",
      );
    stampArtifactProvenance(
      artifact,
      {
        taskId: task.id,
        contextId: task.contextId,
        targetId: grant.agentId,
        targetKind: "local",
      },
      fileSizes,
    );
    const previous = task.artifacts.find(
      (item) => item.artifactId === artifact.artifactId,
    );
    if (previous) {
      if (artifactDigest(previous) !== artifactDigest(artifact))
        throw new RequestMalformedError(
          "This artifactId already identifies different content. Use a new ID for a new version.",
        );
      return { artifactId: artifact.artifactId, replay: true };
    }
    // Reserve the final result slot for the executor.
    if (task.artifacts.length >= A2A_LIMITS.artifactsPerTask - 1)
      throw new UnsupportedOperationError("Task artifact limit reached.");
    task.artifacts.push(artifact);
    await persist(
      tx,
      row,
      task,
      StreamResponse.fromJSON({
        artifactUpdate: {
          taskId: task.id,
          contextId: task.contextId,
          artifact: Artifact.toJSON(artifact),
          append: false,
          lastChunk: true,
        },
      }),
    );
    return { artifactId: artifact.artifactId, replay: false };
  });
}
