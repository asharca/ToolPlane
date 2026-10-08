// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PiPackageManifestV1 } from '@/lib/market/pi-package-manifest';
import { projectPiPackageSkills } from '@/lib/pi-packages/client-artifact';

function fixture(): PiPackageManifestV1 {
  const file = (path: string, text: string) => ({ type: 'file' as const, path, contentEncoding: 'base64' as const, content: Buffer.from(text).toString('base64'), executable: false, sha256: createHash('sha256').update(text).digest('hex') });
  return { schemaVersion: 1, kind: 'pi-package', listing: { slug: 'projection', name: 'Projection', summary: null, iconUrl: null, author: 'fixture', tags: [] }, package: {
    source: { kind: 'toolplane', requested: 'toolplane:projection', name: 'projection', version: '1.0.0' }, name: 'projection', version: '1.0.0', root: 'package',
    runtime: { kind: 'pi-sdk', piVersion: '0.87.1', nodeMajor: 24, platform: 'any', arch: 'any' },
    resources: { extensions: ['package/extension.mjs'], skills: ['package/guide.md'], prompts: ['package/prompt.md'], themes: [] },
    entries: [file('package/guide.md', '---\nname: guide\ndescription: Test skill\n---\nRead assets/example.txt'), file('package/assets/example.txt', 'reviewed data'),
      { type: 'symlink', path: 'package/assets/alias.txt', target: 'example.txt' }, file('package/extension.mjs', 'throw new Error("Pi only")'), file('package/prompt.md', 'Pi prompt only')],
  } };
}

describe('third-party Skill projection', () => {
  it('preserves reviewed relative assets, dereferences internal links, and omits Pi code and prompts', () => {
    const skills = projectPiPackageSkills(fixture());
    expect(skills).toHaveLength(1);
    expect(skills[0].files.map(file => file.path).sort()).toEqual(['SKILL.md', 'assets/alias.txt', 'assets/example.txt']);
    const alias = skills[0].files.find(file => file.path === 'assets/alias.txt')!;
    expect(Buffer.from(alias.content, 'base64').toString()).toBe('reviewed data');
    expect(alias.sha256).toBe(createHash('sha256').update('reviewed data').digest('hex'));
  });
  it('treats a declared SKILL.md directory as one skill rather than discovering nested asset skills', () => {
    const input = fixture();
    input.package.resources.skills = ['package'];
    const guide = input.package.entries.find(entry => entry.path === 'package/guide.md')!;
    guide.path = 'package/SKILL.md';
    input.package.entries.push({ ...guide, path: 'package/examples/nested/SKILL.md' });
    const skills = projectPiPackageSkills(input);
    expect(skills).toHaveLength(1);
    expect(skills[0].files.find(file => file.path === 'SKILL.md')).toBeDefined();
  });
  it('rejects link recursion without emitting a partial Skill projection', () => {
    const input = fixture();
    input.package.entries.push({ type: 'symlink', path: 'package/assets/cycle', target: '.' });
    expect(() => projectPiPackageSkills(input)).toThrow('pi_package_symlink_cycle');
  });
});
