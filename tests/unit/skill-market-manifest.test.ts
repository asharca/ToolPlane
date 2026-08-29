import { describe, expect, it } from 'vitest';
import {
  buildSkillReleaseManifest,
  parseSkillReleaseManifest,
  skillReleaseChecksum,
} from '@/lib/market/skill-manifest';
import { scanSkillReleaseManifest } from '@/lib/market/secret-scan';

const source = {
  skillId: null,
  name: 'Research notes',
  slug: 'research-notes',
  description: 'Summarize research notes.',
  content: '# Research notes\n\nUse the bundled guide.',
  files: [{ path: 'references/guide.md', content: 'Keep citations.' }],
  source: 'upload',
  sourceRef: 'research-notes',
  userInvocable: true,
  agentInvocable: true,
  effort: 'default',
  skill: null,
};

describe('skill market manifests', () => {
  it('builds an immutable secret-free snapshot with a stable checksum', () => {
    const manifest = buildSkillReleaseManifest(source);
    const checksum = skillReleaseChecksum(manifest);

    expect(parseSkillReleaseManifest(manifest, checksum)).toEqual(manifest);
    expect(JSON.stringify(manifest)).not.toContain('apiKey');
    expect(skillReleaseChecksum({ ...manifest })).toBe(checksum);
  });

  it('rejects path traversal and checksum changes', () => {
    const manifest = buildSkillReleaseManifest(source);
    expect(() => parseSkillReleaseManifest({
      ...manifest,
      skill: { ...manifest.skill, files: [{ path: '../secret', content: 'x' }] },
    })).toThrow('invalid files');
    expect(() => parseSkillReleaseManifest(manifest, '0'.repeat(64))).toThrow('checksum');
  });

  it('blocks high-confidence credentials without retaining their values', () => {
    const secret = 'sk-proj-1234567890abcdefghijklmnop';
    const manifest = buildSkillReleaseManifest({ ...source, content: `# Unsafe\n\n${secret}` });
    const result = scanSkillReleaseManifest(manifest);

    expect(result).toMatchObject({
      status: 'blocked',
      findings: [{ kind: 'openai_key', path: 'manifest.skill.content' }],
    });
    expect(JSON.stringify(result)).not.toContain(secret);

    const descriptionResult = scanSkillReleaseManifest({
      ...buildSkillReleaseManifest(source),
      skill: { ...buildSkillReleaseManifest(source).skill, description: secret },
    });
    expect(descriptionResult.findings).toContainEqual({
      kind: 'openai_key',
      path: 'manifest.skill.description',
    });
  });
});
