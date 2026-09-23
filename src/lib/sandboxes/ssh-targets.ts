import 'server-only';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const AbsolutePath = z.string().min(2).max(2048).startsWith('/')
  .refine((value) => !/[\x00-\x1f\x7f\\]/.test(value) && !value.split('/').includes('..'));
const CredentialPath = AbsolutePath.refine((value) => !/\s/.test(value));
const Target = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/),
  name: z.string().trim().min(1).max(80),
  workspaceIds: z.array(z.string().min(1).max(128)).min(1).max(100),
  host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.:-]{0,252}$/),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/),
  root: AbsolutePath,
  identityFile: CredentialPath,
  knownHostsFile: CredentialPath,
}).strict();
const Targets = z.array(Target).max(256);
export type SshTarget = z.infer<typeof Target>;

// Only the instance administrator controls this file and its mounted keys.
// Database config stores a target ID, never a hostname override or private key.
function readTargets(): SshTarget[] {
  const filename = process.env.TOOLPLANE_SSH_TARGETS_FILE;
  if (!filename) return [];
  try {
    const text = readFileSync(filename, 'utf8');
    if (Buffer.byteLength(text) > 1_000_000) throw new Error();
    const rows = Targets.parse(JSON.parse(text));
    if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error();
    return rows;
  } catch { throw new Error('SSH target configuration is unavailable or invalid.'); }
}
export function listSshTargetsForWorkspace(workspaceId: string) {
  return readTargets().filter((row) => row.workspaceIds.includes(workspaceId))
    .map(({ id, name }) => ({ id, name }));
}
export function resolveSshTargetForWorkspace(id: string, workspaceId: string) {
  const row = readTargets().find((target) => target.id === id && target.workspaceIds.includes(workspaceId));
  if (!row) throw new Error('SSH target is not authorized for this workspace.');
  const { host, port, username, root, identityFile, knownHostsFile } = row;
  return { host, port, username, root, identityFile, knownHostsFile };
}
export function sshTargetIdFromConfig(config: unknown): string | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const value = (config as Record<string, unknown>).sshTargetId;
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value) ? value : null;
}
