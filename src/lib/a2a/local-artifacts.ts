import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Artifact, StreamResponse, Task, TaskState, SendMessageRequest } from '@a2a-js/sdk';
import { TaskNotFoundError, RequestMalformedError, UnsupportedOperationError } from '@a2a-js/sdk/errors';
import { db } from '@/lib/db';
import { A2A_LIMITS, acceptsOutput } from './model';
import { isLocalGrant, type TaskGrant } from './principal';
import { assertLocalGrant } from './local-policy';
import { lockTask, persist } from './store';

export const LOCAL_ARTIFACT_BYTES = A2A_LIMITS.publishArtifactBytes;
const Mime = z.enum(['text/plain', 'text/markdown', 'text/x-diff', 'application/json', 'application/octet-stream']);
const Part = z.object({ text: z.string().optional(), data: z.record(z.string(), z.unknown()).optional(), raw: z.string().optional(),
  mediaType: Mime.optional() }).strict().refine((part) => [part.text, part.data, part.raw].filter((value) => value !== undefined).length === 1);
export const LocalArtifactInput = z.object({ artifactId: z.string().min(1).max(128).regex(/^[\w.:-]+$/),
  name: z.string().min(1).max(100).regex(/^[^\x00-\x1f\x7f/\\]+$/),
  description: z.string().max(1000).optional(), parts: z.array(Part).min(1).max(8) }).strict();

export function parseLocalArtifact(raw: unknown): Artifact {
  const value = LocalArtifactInput.parse(raw);
  let bytes = 0;
  for (const part of value.parts) {
    if (part.raw !== undefined) {
      if (!part.mediaType || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(part.raw)) throw new RequestMalformedError('File bytes must be canonical base64 with a mediaType.');
      const content = Buffer.from(part.raw, 'base64');
      if (content.toString('base64') !== part.raw) throw new RequestMalformedError('Non-canonical file bytes.');
      bytes += content.length;
    } else if (part.data !== undefined) {
      if (part.mediaType && part.mediaType !== 'application/json') throw new RequestMalformedError('Structured data must have application/json mediaType.');
      part.mediaType = 'application/json'; bytes += Buffer.byteLength(JSON.stringify(part.data), 'utf8');
    } else { bytes += Buffer.byteLength(part.text!, 'utf8'); part.mediaType ??= 'text/plain'; }
  }
  if (bytes > LOCAL_ARTIFACT_BYTES) throw new UnsupportedOperationError('Artifact content exceeds 32 KiB.');
  return Artifact.fromJSON(value);
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
const artifactDigest = (value: Artifact) => createHash('sha256').update(JSON.stringify(canonical(Artifact.toJSON(value)))).digest('hex');

/** Publish a standard, bounded Artifact to the caller-owned native task, never an arbitrary path or URL. */
export async function publishLocalArtifact(taskId: string, lease: string, raw: unknown) {
  const artifact = parseLocalArtifact(raw);
  return db.$transaction(async (tx) => {
    const row = await lockTask(tx, taskId); const grant = row.grant as unknown as TaskGrant;
    if (!isLocalGrant(grant) || row.state !== TaskState.TASK_STATE_WORKING || row.phase !== 'executing'
      || row.leaseToken !== lease || row.cancelRequestedAt || row.pendingQuestion || row.waitForTaskIds.length || row.deadlineAt <= new Date()) throw new TaskNotFoundError();
    await assertLocalGrant(grant, tx);
    const task = Task.fromJSON(row.snapshot);
    const modes = SendMessageRequest.fromJSON(row.request).configuration?.acceptedOutputModes ?? [];
    if (artifact.parts.some((part) => !acceptsOutput(modes, part.mediaType || 'text/plain'))) throw new UnsupportedOperationError('Artifact mediaType was not accepted by the caller.');
    const previous = task.artifacts.find((item) => item.artifactId === artifact.artifactId);
    if (previous) {
      if (artifactDigest(previous) !== artifactDigest(artifact)) throw new RequestMalformedError('This artifactId already identifies different content. Use a new ID for a new version.');
      return { artifactId: artifact.artifactId, replay: true };
    }
    // Reserve the final result slot for the executor.
    if (task.artifacts.length >= A2A_LIMITS.artifactsPerTask - 1) throw new UnsupportedOperationError('Task artifact limit reached.');
    task.artifacts.push(artifact);
    await persist(tx, row, task, StreamResponse.fromJSON({ artifactUpdate: {
      taskId: task.id, contextId: task.contextId, artifact: Artifact.toJSON(artifact), append: false, lastChunk: true,
    } }));
    return { artifactId: artifact.artifactId, replay: false };
  });
}
