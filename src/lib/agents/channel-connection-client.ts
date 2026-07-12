import type { AgentChannelConnectionView } from '@/lib/agents/channel-connections';

export type AgentChannelConnectionClientView = Pick<
  AgentChannelConnectionView,
  | 'id'
  | 'platform'
  | 'platformLabel'
  | 'name'
  | 'status'
  | 'connectionMode'
  | 'credentialNames'
  | 'missingStartCredentialNames'
  | 'pairing'
  | 'lastError'
>;

export function toAgentChannelConnectionClientView(
  connection: AgentChannelConnectionView,
): AgentChannelConnectionClientView {
  return {
    id: connection.id,
    platform: connection.platform,
    platformLabel: connection.platformLabel,
    name: connection.name,
    status: connection.status,
    connectionMode: connection.connectionMode,
    credentialNames: connection.credentialNames,
    missingStartCredentialNames: connection.missingStartCredentialNames,
    pairing: connection.pairing,
    lastError: connection.lastError,
  };
}
