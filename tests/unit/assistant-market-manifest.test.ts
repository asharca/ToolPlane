import { describe, expect, it } from 'vitest';
import {
  assistantReleaseChecksum,
  buildAssistantReleaseManifest,
  parseAssistantReleaseManifest,
} from '@/lib/market/assistant-manifest';
import { scanMarketArtifact } from '@/lib/market/secret-scan';

const source = {
  name: 'Research assistant',
  systemPrompt: 'Summarize sources with citations.',
  model: 'gpt-5.6',
  maxSteps: 8,
  modelProvider: { format: 'openai-compatible' },
  mcpGrants: [{
    deployment: {
      name: 'Web search',
      sourceRef: null,
      server: { slug: 'web-search', name: 'Web search' },
    },
  }],
};

describe('assistant market manifests', () => {
  it('keeps only portable requirements and verifies a stable checksum', () => {
    const manifest = buildAssistantReleaseManifest(source);
    const checksum = assistantReleaseChecksum(manifest);

    expect(parseAssistantReleaseManifest(manifest, checksum)).toEqual(manifest);
    expect(manifest.assistant).toMatchObject({
      modelRequirement: { providerFormat: 'openai-compatible', model: 'gpt-5.6' },
      mcpRequirements: [{ catalogSlug: 'web-search', name: 'Web search' }],
    });
    expect(assistantReleaseChecksum({ ...manifest })).toBe(checksum);
  });

  it('rejects checksum changes and blocks credentials in assistant text', () => {
    const manifest = buildAssistantReleaseManifest(source);
    expect(() => parseAssistantReleaseManifest(manifest, '0'.repeat(64))).toThrow('checksum');

    const secret = `sk-proj-${'a'.repeat(24)}`;
    const result = scanMarketArtifact({
      ...manifest,
      assistant: { ...manifest.assistant, systemPrompt: secret },
    });
    expect(result).toMatchObject({
      status: 'blocked',
      findings: [{ kind: 'openai_key', path: 'manifest.assistant.systemPrompt' }],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('uses the shared agent tool-loop bounds', () => {
    expect(buildAssistantReleaseManifest({ ...source, maxSteps: 1_000 }).assistant.maxSteps).toBe(1_000);
    expect(() => buildAssistantReleaseManifest({ ...source, maxSteps: 0 })).toThrow('invalid');
    expect(() => buildAssistantReleaseManifest({ ...source, maxSteps: 1_001 })).toThrow('invalid');
  });
});
