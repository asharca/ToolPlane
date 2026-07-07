import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchGithubSkillBundle,
  normalizeSkillFiles,
  parseGithubSkillSource,
  parseSkillFrontmatter,
  parseUploadedSkillBundle,
  parseUploadedSkillBundles,
  safeSkillFilePath,
} from '@/lib/skills/bundle';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseGithubSkillSource', () => {
  it('accepts shorthand skill folders', () => {
    expect(parseGithubSkillSource('anthropics/skills/skills/pdf')).toMatchObject({
      owner: 'anthropics',
      repo: 'skills',
      ref: 'HEAD',
      path: 'skills/pdf',
      normalized: 'anthropics/skills/skills/pdf',
    });
  });

  it('accepts GitHub tree URLs with explicit refs', () => {
    expect(
      parseGithubSkillSource('https://github.com/anthropics/skills/tree/main/skills/pdf'),
    ).toMatchObject({
      owner: 'anthropics',
      repo: 'skills',
      ref: 'main',
      path: 'skills/pdf',
      normalized: 'https://github.com/anthropics/skills/tree/main/skills/pdf',
    });
  });
});

describe('skill bundle path guards', () => {
  it('rejects unsafe paths', () => {
    expect(safeSkillFilePath('../secret')).toBeNull();
    expect(safeSkillFilePath('/tmp/x')).toBeNull();
    expect(safeSkillFilePath('scripts/../../x')).toBeNull();
    expect(safeSkillFilePath('node_modules/pkg/index.js')).toBeNull();
    expect(safeSkillFilePath('._SKILL.md')).toBeNull();
    expect(safeSkillFilePath('__MACOSX/SKILL.md')).toBeNull();
  });

  it('keeps safe nested files and excludes SKILL.md from extras', () => {
    expect(
      normalizeSkillFiles([
        { path: 'SKILL.md', content: '# Skill' },
        { path: './scripts/render.py', content: 'print(1)' },
        { path: 'assets/font.ttf', content: Buffer.from('font').toString('base64'), encoding: 'base64' },
        { path: 'reference.md', content: 'ref' },
      ]),
    ).toEqual([
      { path: 'scripts/render.py', content: 'print(1)' },
      { path: 'assets/font.ttf', content: Buffer.from('font').toString('base64'), encoding: 'base64' },
      { path: 'reference.md', content: 'ref' },
    ]);
  });
});

describe('parseSkillFrontmatter', () => {
  it('extracts quoted metadata', () => {
    expect(
      parseSkillFrontmatter('---\nname: "pdf"\ndescription: "Work with PDFs"\nauthor: Anthropic\n---\n# PDF'),
    ).toEqual({ name: 'pdf', description: 'Work with PDFs', author: 'Anthropic' });
  });
});

describe('parseUploadedSkillBundle', () => {
  it('strips the selected folder root and keeps nested bundled files', () => {
    const bundle = parseUploadedSkillBundle([
      {
        path: 'pdf/SKILL.md',
        content: '---\nname: pdf\ndescription: Work with PDFs\nauthor: Anthropic\n---\n# PDF',
      },
      { path: 'pdf/reference.md', content: 'reference' },
      { path: 'pdf/assets/font.ttf', content: Buffer.from('font').toString('base64'), encoding: 'base64' },
      { path: 'other/ignored.md', content: 'ignored' },
    ]);

    expect(bundle).toMatchObject({
      name: 'pdf',
      description: 'Work with PDFs',
      author: 'Anthropic',
      rootPath: 'pdf',
      content: expect.stringContaining('# PDF'),
    });
    expect(bundle.files).toEqual([
      { path: 'reference.md', content: 'reference' },
      { path: 'assets/font.ttf', content: Buffer.from('font').toString('base64'), encoding: 'base64' },
    ]);
  });

  it('requires a SKILL.md file', () => {
    expect(() => parseUploadedSkillBundle([{ path: 'README.md', content: 'No skill here' }])).toThrow(
      'SKILL.md not found',
    );
  });

  it('imports each child folder with a SKILL.md as its own skill', () => {
    const bundles = parseUploadedSkillBundles([
      {
        path: 'yibao-shenji/skill_data_reader/SKILL.md',
        content: '---\nname: skill_data_reader\ndescription: Read fee details\n---\n# Reader',
      },
      { path: 'yibao-shenji/skill_data_reader/scripts/read.py', content: 'print(1)' },
      {
        path: 'yibao-shenji/step_1_读取项目明细表费用明细层/SKILL.md',
        content: '# Step 1',
      },
      { path: 'yibao-shenji/step_1_读取项目明细表费用明细层/reference.md', content: 'rules' },
      { path: 'yibao-shenji/README.md', content: 'collection readme' },
    ]);

    expect(bundles.map((bundle) => ({ name: bundle.name, rootPath: bundle.rootPath }))).toEqual([
      { name: 'skill_data_reader', rootPath: 'yibao-shenji/skill_data_reader' },
      { name: 'step_1_读取项目明细表费用明细层', rootPath: 'yibao-shenji/step_1_读取项目明细表费用明细层' },
    ]);
    expect(bundles[0].files).toEqual([{ path: 'scripts/read.py', content: 'print(1)' }]);
    expect(bundles[1].files).toEqual([{ path: 'reference.md', content: 'rules' }]);
  });
});

describe('fetchGithubSkillBundle', () => {
  it('recursively imports SKILL.md plus nested files', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        const href = String(url);
        if (href.includes('/contents/skills/pdf?')) {
          return Response.json([
            {
              type: 'file',
              name: 'SKILL.md',
              path: 'skills/pdf/SKILL.md',
              size: 42,
              download_url: 'https://raw.test/SKILL.md',
            },
            {
              type: 'file',
              name: 'reference.md',
              path: 'skills/pdf/reference.md',
              size: 12,
              download_url: 'https://raw.test/reference.md',
            },
            {
              type: 'file',
              name: 'font.ttf',
              path: 'skills/pdf/font.ttf',
              size: 4,
              download_url: 'https://raw.test/font.ttf',
            },
            { type: 'dir', name: 'scripts', path: 'skills/pdf/scripts' },
          ]);
        }
        if (href.includes('/contents/skills/pdf/scripts?')) {
          return Response.json([
            {
              type: 'file',
              name: 'convert.py',
              path: 'skills/pdf/scripts/convert.py',
              size: 8,
              download_url: 'https://raw.test/convert.py',
            },
          ]);
        }
        if (href === 'https://raw.test/SKILL.md') {
          return new Response('---\nname: pdf\ndescription: Work with PDFs\n---\n# PDF');
        }
        if (href === 'https://raw.test/reference.md') return new Response('reference');
        if (href === 'https://raw.test/convert.py') return new Response('print(1)');
        if (href === 'https://raw.test/font.ttf') return new Response(Buffer.from('font'));
        return new Response('not found', { status: 404 });
      }),
    );

    const bundle = await fetchGithubSkillBundle('anthropics/skills/skills/pdf');
    expect(bundle.name).toBe('pdf');
    expect(bundle.content).toContain('# PDF');
    expect(bundle.files).toEqual([
      { path: 'reference.md', content: 'reference' },
      { path: 'font.ttf', content: Buffer.from('font').toString('base64'), encoding: 'base64' },
      { path: 'scripts/convert.py', content: 'print(1)' },
    ]);
  });
});
