import type { AgentChannelConnectionView } from '@/lib/agents/channel-connections';

export type AgentChannelConnectionClientView = Pick<
  AgentChannelConnectionView,
  | 'id'
  | 'agentId'
  | 'sandboxId'
  | 'platform'
  | 'platformLabel'
  | 'name'
  | 'status'
  | 'connectionMode'
  | 'credentialNames'
  | 'credentialValues'
  | 'missingStartCredentialNames'
  | 'pairing'
  | 'lastError'
>;

export function toAgentChannelConnectionClientView(
  connection: AgentChannelConnectionView,
): AgentChannelConnectionClientView {
  return {
    id: connection.id,
    agentId: connection.agentId,
    sandboxId: connection.sandboxId,
    platform: connection.platform,
    platformLabel: connection.platformLabel,
    name: connection.name,
    status: connection.status,
    connectionMode: connection.connectionMode,
    credentialNames: connection.credentialNames,
    credentialValues: connection.credentialValues,
    missingStartCredentialNames: connection.missingStartCredentialNames,
    pairing: connection.pairing,
    lastError: connection.lastError,
  };
}
