import { describe, expect, it } from 'vitest';
import { scanAgentReleaseManifest } from '@/lib/market/secret-scan';

describe('scanAgentReleaseManifest', () => {
  it('blocks credentials in prompts, skill text, and decoded base64 files without returning them', () => {
    const promptSecret = `sk-proj-${'a'.repeat(24)}`;
    const skillSecret = `ghp_${'b'.repeat(24)}`;
    const fileSecret = `xoxb-${'c'.repeat(24)}`;
    const result = scanAgentReleaseManifest({
      agents: [{ systemPrompt: `Use ${promptSecret}` }],
      skills: [{
        content: `Token ${skillSecret}`,
        files: [{
          content: Buffer.from(`Slack ${fileSecret}`, 'utf8').toString('base64'),
          encoding: 'base64',
        }],
      }],
    });

    expect(result.status).toBe('blocked');
    expect(result.findings.map(({ path }) => path)).toEqual(expect.arrayContaining([
      'manifest.agents[0].systemPrompt',
      'manifest.skills[0].content',
      'manifest.skills[0].files[0].content(decoded)',
    ]));
    expect(JSON.stringify(result)).not.toContain(promptSecret);
    expect(JSON.stringify(result)).not.toContain(skillSecret);
    expect(JSON.stringify(result)).not.toContain(fileSecret);
  });
});
