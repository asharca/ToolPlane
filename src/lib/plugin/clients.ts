export const INSTALL_CLIENTS = ['claude-code', 'codex', 'opencode', 'hermes'] as const;
export type InstallClient = (typeof INSTALL_CLIENTS)[number];

const INSTALL_CLIENT_LABELS: Record<InstallClient, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  hermes: 'Hermes',
  opencode: 'opencode',
};

export function installClientLabel(client: InstallClient): string {
  return INSTALL_CLIENT_LABELS[client];
}

export function resolveInstallClient(raw: string | null | undefined): InstallClient {
  return (INSTALL_CLIENTS as readonly string[]).includes(raw ?? '')
    ? (raw as InstallClient)
    : 'claude-code';
}
