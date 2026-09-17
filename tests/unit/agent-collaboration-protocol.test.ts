// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { COLLABORATION_TOOLS, DelegateInput, ContinueInput, ArtifactInput, GetInput, terminal } from '@/lib/agents/collaboration/protocol';
import { readCollaborationJson } from '@/lib/agents/collaboration/http';

describe('collaboration protocol boundary', () => {
  it('does not accept caller identity, ancestry, arbitrary network targets or permission overrides from a model', () => {
    const value = { agentId: 'agent-1', messageId: 'request-1', message: 'Review' };
    expect(DelegateInput.parse(value)).toEqual(value);
    for (const extra of ['callerAgentId', 'depth', 'rootId', 'url', 'approvedById', 'workspaceId']) {
      expect(DelegateInput.safeParse({ ...value, [extra]: 'forged' }).success).toBe(false);
    }
    expect(DelegateInput.safeParse({ ...value, agentId: 'https://internal/private' }).success).toBe(false);
  });
  it('bounds UTF-8 bytes, message IDs and server wait time', () => {
    expect(DelegateInput.safeParse({ agentId: 'a', messageId: 'b', message: '中'.repeat(12000) }).success).toBe(false);
    expect(ContinueInput.safeParse({ taskId: 't', messageId: '', message: 'x' }).success).toBe(false);
    expect(GetInput.safeParse({ taskId: 't', waitSeconds: 21 }).success).toBe(false);
    expect(ArtifactInput.safeParse({ artifactId: 'x', name: 'file', text: 'x', url: 'file:///etc/passwd' }).success).toBe(false);
  });
  it('documents distinct terminal and waiting states', () => {
    for (const state of ['failed', 'completed', 'canceled', 'rejected']) expect(terminal(state)).toBe(true);
    for (const state of ['working', 'input-required', 'auth-required', 'submitted']) expect(terminal(state)).toBe(false);
    expect(new Set(COLLABORATION_TOOLS.map((tool) => tool.name)).size).toBe(8);
    expect(COLLABORATION_TOOLS.some((tool) => tool.name.includes('approve'))).toBe(false);
  });
  it('enforces the body limit even when Content-Length is missing or forged', async () => {
    const req = new Request('http://localhost', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '1' }, body: JSON.stringify({ text: 'x'.repeat(100) }) });
    await expect(readCollaborationJson(req, 32)).rejects.toMatchObject({ code: 'too_large' });
    await expect(readCollaborationJson(new Request('http://localhost', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' }))).rejects.toMatchObject({ code: 'invalid_json' });
  });
});
