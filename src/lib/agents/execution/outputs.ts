import "server-only";
import { posix } from "node:path";
import type { A2ATask } from "@prisma/client";
import { publishLocalArtifact } from "@/lib/a2a/local-artifacts";
import { listSandboxFiles } from "@/lib/a2a/local-sandbox";
import { mimeTypeForFilename } from "@/lib/file-preview";
import { recordEvent } from "@/lib/observability/events";

const OUTPUTS_DIRECTORY = "outputs";
const MAX_OUTPUT_FILES = 8;
const MAX_FILENAME_LENGTH = 100;

export function outputsInstruction(workspaceRoot: string) {
  return `Deliverables: files you create or update under ${workspaceRoot}/${OUTPUTS_DIRECTORY}/ during this task are attached to your reply automatically when the turn completes (at most ${MAX_OUTPUT_FILES} files; do not also publish them with a2a_publish_artifact).`;
}

// The artifact schema counts UTF-16 units. Never split a surrogate pair at the cut.
function prefix(value: string, limit: number) {
  if (value.length <= limit) return value;
  const last = value.charCodeAt(limit - 1);
  return value.slice(0, last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit);
}

function outputFilename(path: string) {
  const name = posix.basename(path);
  if (name.length <= MAX_FILENAME_LENGTH) return name;
  const extension = posix.extname(name);
  const stemMinimum = (name.codePointAt(0) ?? 0) > 0xffff ? 2 : 1;
  const suffix = prefix(extension, MAX_FILENAME_LENGTH - stemMinimum);
  return (
    prefix(
      name.slice(0, name.length - extension.length),
      MAX_FILENAME_LENGTH - suffix.length,
    ) + suffix
  );
}

export async function publishTurnOutputs(row: A2ATask, signal: AbortSignal) {
  const { files, truncated } = await listSandboxFiles(
    row,
    OUTPUTS_DIRECTORY,
    {
      maxEntries: MAX_OUTPUT_FILES,
      newerThanMs: row.createdAt.getTime(),
    },
    signal,
  );
  if (!files.length) return;
  if (truncated) {
    await recordEvent({
      domain: "agent",
      eventName: "agent.outputs.truncated",
      level: "info",
      taskId: row.id,
    });
  }
  if (!row.leaseToken) throw new Error("Not a claimed local task.");
  await publishLocalArtifact(row.id, row.leaseToken, {
    artifactId: "toolplane-outputs",
    name: OUTPUTS_DIRECTORY,
    parts: files.map(({ path }) => ({
      path: `${OUTPUTS_DIRECTORY}/${path}`,
      filename: outputFilename(path),
      mediaType: mimeTypeForFilename(path),
    })),
  });
}
