// @vitest-environment node
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

import {
  AttachmentTooLargeError,
  workspaceAttachmentVolumeName,
  writeWorkspaceAttachment,
} from '@/lib/attachments/storage';

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  killed = false;
  private closed = false;

  finish(code: number | null = 0, signal: NodeJS.Signals | null = null) {
    if (this.closed) return;
    this.closed = true;
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit('close', code, signal));
  }

  kill(signal: NodeJS.Signals = 'SIGTERM') {
    this.killed = true;
    this.finish(null, signal);
    return true;
  }
}

function body(value: string) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

describe('workspace attachment Docker storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.spawn.mockImplementation((_command: string, args: string[]) => {
      const child = new FakeChild();
      if (args.includes('-i')) child.stdin.once('finish', () => child.finish());
      else queueMicrotask(() => child.finish());
      return child;
    });
  });

  it('derives a dedicated Docker-safe volume and streams through a restricted helper', async () => {
    const result = await writeWorkspaceAttachment({
      workspaceId: 'workspace_1',
      filename: '../../notes with spaces.txt',
      body: body('hello'),
      maxBytes: 10,
    });

    expect(workspaceAttachmentVolumeName('workspace_1')).toBe('toolplane_attachment_workspace_1');
    expect(result.size).toBe(5);
    expect(result.storagePath).toMatch(/^objects\/[0-9a-f-]+-notes-with-spaces\.txt$/);
    const uploadArgs = mocks.spawn.mock.calls.map((call) => call[1] as string[]).find((args) => args.includes('-i'))!;
    expect(uploadArgs).toEqual(expect.arrayContaining([
      'run',
      '--rm',
      '-i',
      '--network',
      'none',
      '--read-only',
      '--memory',
      '128m',
      '--cpus',
      '0.25',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
    ]));
    expect(uploadArgs.join(' ')).toContain('type=volume,src=toolplane_attachment_workspace_1,dst=/attachments');
  });

  it('stops a streamed upload at the server limit before finalizing it', async () => {
    await expect(writeWorkspaceAttachment({
      workspaceId: 'workspace_1',
      filename: 'notes.txt',
      body: body('too large'),
      maxBytes: 4,
    })).rejects.toBeInstanceOf(AttachmentTooLargeError);

    const scripts = mocks.spawn.mock.calls.flatMap((call) => call[1] as string[]);
    expect(scripts.some((value) => value.includes('wc -c'))).toBe(false);
  });

  it('rejects workspace ids that cannot safely become Docker volume names', () => {
    expect(() => workspaceAttachmentVolumeName('../workspace')).toThrow('Invalid workspace id.');
  });
});
