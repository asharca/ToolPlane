import { createHash } from 'node:crypto';

export type InstallationIdentity = {
  base: string;
  workspaceSlug: string;
  toolkitSlug: string;
  workspaceId?: string;
  toolkitId?: string;
};

// Display names are not identities. Stable DB IDs survive renames, while the
// normalized service URL includes the base path to distinguish installations.
export function installationName(input: InstallationIdentity): string {
  const url = new URL(input.base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Invalid ToolPlane service URL.');
  }
  url.hash = '';
  url.search = '';
  const base = url.toString().replace(/\/+$/, '');
  const identity = [base, input.workspaceId ?? input.workspaceSlug, input.toolkitId ?? input.toolkitSlug];
  return `toolplane-${createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 24)}`;
}
