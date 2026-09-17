/** Ordinary Hermes attachments only; snapshots/imports/Connector disks are separate budgets. */
export class AttachmentAdmissionError extends Error {
  constructor(message: string, public readonly status = 409) { super(message); }
}
function limit(key: string, fallback: number, max: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new AttachmentAdmissionError(`Invalid ${key}`, 503);
  return Math.min(value, max);
}
export function attachmentBudget() {
  return {
    workspaceBytes: limit('TOOLPLANE_ATTACHMENT_WORKSPACE_BYTES', 20_000_000_000, 1_000_000_000_000),
    agentBytes: limit('TOOLPLANE_ATTACHMENT_AGENT_BYTES', 5_000_000_000, 1_000_000_000_000),
    concurrentUploads: limit('TOOLPLANE_ATTACHMENT_CONCURRENT_UPLOADS', 2, 32),
  };
}
export function reservedUploadBytes(contentLength: string | null, maxBytes: number): number {
  if (contentLength === null) return maxBytes;
  if (!/^[0-9]+$/.test(contentLength)) throw new AttachmentAdmissionError('Invalid Content-Length.', 400);
  const declared = Number(contentLength);
  if (!Number.isSafeInteger(declared) || declared <= 0) throw new AttachmentAdmissionError('A non-empty file is required.', 400);
  if (declared > maxBytes) throw new AttachmentAdmissionError('Attachment exceeds the configured limit.', 413);
  return declared;
}
export function checkAttachmentBudget(input: {
  workspaceUsed: number; agentUsed: number; pendingWorkspace: number; pendingAgent: number;
  active: number; requested: number;
}, limits = attachmentBudget()) {
  if (input.active >= limits.concurrentUploads) throw new AttachmentAdmissionError('Attachment upload concurrency limit reached.', 429);
  if (input.workspaceUsed + input.pendingWorkspace + input.requested > limits.workspaceBytes
    || input.agentUsed + input.pendingAgent + input.requested > limits.agentBytes) {
    throw new AttachmentAdmissionError('Attachment storage quota exceeded. Remove unused files or increase the deployment quota.', 413);
  }
}
export function boundedUploadStream(body: ReadableStream<Uint8Array>, reserved: number, onOverflow: () => void) {
  let bytes = 0;
  let complete = false;
  let exceeded = false;
  const stream = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (bytes + chunk.byteLength > reserved) {
        exceeded = true; onOverflow();
        throw new AttachmentAdmissionError('Attachment exceeds its reserved byte limit.', 413);
      }
      bytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
    flush() { complete = true; },
  }));
  return { stream, bytes: () => bytes, complete: () => complete, exceeded: () => exceeded };
}
