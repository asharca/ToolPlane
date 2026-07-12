import { describe, expect, it } from 'vitest';
import type { AgentChannelConnectionView } from '@/lib/agents/channel-connections';
import { toAgentChannelConnectionClientView } from '@/lib/agents/channel-connection-client';

describe('toAgentChannelConnectionClientView', () => {
  it('only exposes fields used by the messaging settings UI', () => {
    const connection: AgentChannelConnectionView = {
      id: 'connection-1',
      agentId: 'agent-1',
      workspaceId: 'workspace-1',
      platform: 'telegram',
      platformLabel: 'Telegram',
      name: 'Support bot',
      status: 'running',
      publicEndpointRequired: true,
      setupFlow: 'pairing',
      connectionMode: 'hosted',
      runnerSupported: true,
      credentialNames: ['botToken'],
      missingStartCredentialNames: [],
      pairing: null,
      inboundToken: 'secret-inbound-token',
      inboundTokenPrefix: 'secret-i',
      runnerPid: 1234,
      lastError: null,
      lastStartedAt: new Date('2026-07-12T01:00:00.000Z'),
      lastEventAt: new Date('2026-07-12T02:00:00.000Z'),
      createdAt: new Date('2026-07-11T01:00:00.000Z'),
      updatedAt: new Date('2026-07-12T03:00:00.000Z'),
    };

    expect(toAgentChannelConnectionClientView(connection)).toEqual({
      id: 'connection-1',
      platform: 'telegram',
      platformLabel: 'Telegram',
      name: 'Support bot',
      status: 'running',
      connectionMode: 'hosted',
      credentialNames: ['botToken'],
      missingStartCredentialNames: [],
      pairing: null,
      lastError: null,
    });
  });
});
