import { describe, expect, it } from 'vitest';
import {
  CreateChatAssistantSchema,
  UpdateChatAssistantSchema,
  parseChatTurn,
} from '@/lib/chat/schemas';

describe('chat bounded-context input', () => {
  it('accepts only chat assistant capabilities and deduplicates direct MCP grants', () => {
    const result = CreateChatAssistantSchema.parse({
      workspaceId: 'ws-1',
      name: 'Helper',
      modelProviderId: 'provider-1',
      model: 'gpt-5',
      deploymentIds: ['mcp-1', 'mcp-1'],
      skillIds: ['skill-1'],
      sandboxId: 'sandbox-1',
      runtime: 'hermes',
    });

    expect(result.deploymentIds).toEqual(['mcp-1']);
    expect(result).not.toHaveProperty('skillIds');
    expect(result).not.toHaveProperty('sandboxId');
    expect(result).not.toHaveProperty('runtime');
  });

  it('requires a real patch and a user message as the final turn message', () => {
    expect(UpdateChatAssistantSchema.safeParse({}).success).toBe(false);
    expect(UpdateChatAssistantSchema.safeParse({
      modelProviderId: 'provider-2',
      model: 'model-2',
    }).success).toBe(true);
    expect(parseChatTurn({
      messages: [{ id: 'a-1', role: 'assistant', parts: [{ type: 'text', text: 'done' }] }],
    })).toBeNull();
    expect(parseChatTurn({
      messages: [{ id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
      trigger: 'regenerate-message',
      messageId: 'a-1',
    })).toMatchObject({
      trigger: 'regenerate-message',
      messageId: 'a-1',
      messages: [expect.objectContaining({ id: 'u-1' })],
    });
  });

  it('caps assistant tool steps at the UI limit', () => {
    expect(CreateChatAssistantSchema.safeParse({
      workspaceId: 'ws-1',
      name: 'Helper',
      maxSteps: 20,
    }).success).toBe(true);
    expect(CreateChatAssistantSchema.safeParse({
      workspaceId: 'ws-1',
      name: 'Helper',
      maxSteps: 21,
    }).success).toBe(false);
  });
});
