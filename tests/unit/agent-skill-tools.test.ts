import { describe, expect, it } from 'vitest';
import { buildSkillToolSet } from '@/lib/agents/skill-tools';

type ToolExec = (args: Record<string, unknown>, opts?: unknown) => Promise<unknown>;

const pdfSkill = {
  skillId: null,
  skill: null,
  name: 'PDF',
  slug: 'pdf',
  description: 'Work with PDFs',
  content: '# PDF\n\nUse the bundled scripts for PDF work.',
  files: [
    { path: 'reference.md', content: 'PDF reference' },
    {
      path: 'scripts/echo.js',
      content: "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), secret: process.env.DATABASE_URL || '' }))",
    },
  ],
  userInvocable: true,
  agentInvocable: true,
  status: 'published',
  effort: 'default',
};

const binarySkill = {
  skillId: null,
  skill: null,
  name: 'Canvas',
  slug: 'canvas',
  description: 'Uses fonts',
  content: '# Canvas',
  files: [
    { path: 'scripts/echo.js', content: "process.stdout.write('ok')" },
    { path: 'assets/font.ttf', content: Buffer.from('font').toString('base64'), encoding: 'base64' as const },
  ],
  userInvocable: true,
  agentInvocable: true,
  status: 'published',
  effort: 'default',
};

describe('buildSkillToolSet', () => {
  it('exposes attached skills as readable runtime resources', async () => {
    const set = buildSkillToolSet([pdfSkill]);

    expect(Object.keys(set).sort()).toEqual(['skill_list_attached', 'skill_read_file', 'skill_run_script']);

    const list = (await (set.skill_list_attached.execute as ToolExec)({})) as {
      skills: { slug: string; files: string[] }[];
    };
    expect(list.skills).toEqual([
      expect.objectContaining({
        slug: 'pdf',
        name: 'PDF',
        files: ['SKILL.md', 'reference.md', 'scripts/echo.js'],
        runnableScripts: ['scripts/echo.js'],
      }),
    ]);

    const skillMd = (await (set.skill_read_file.execute as ToolExec)({ skill: 'pdf', path: 'SKILL.md' })) as {
      content: string;
    };
    expect(skillMd.content).toContain('# PDF');

    const reference = (await (set.skill_read_file.execute as ToolExec)({ skill: 'pdf', path: 'reference.md' })) as {
      content: string;
    };
    expect(reference.content).toBe('PDF reference');
  });

  it('refuses unsafe file paths', async () => {
    const set = buildSkillToolSet([pdfSkill]);
    const out = (await (set.skill_read_file.execute as ToolExec)({ skill: 'pdf', path: '../secret' })) as {
      error: string;
    };
    expect(out.error).toMatch(/Invalid skill file path/);
  });

  it('runs bundled scripts with a minimal environment', async () => {
    const set = buildSkillToolSet([pdfSkill]);
    const out = (await (set.skill_run_script.execute as ToolExec)({
      skill: 'pdf',
      path: 'scripts/echo.js',
      args: ['one', 'two'],
    })) as {
      exitCode: number | null;
      stdout: string;
      stderr: string;
    };

    expect(out.exitCode).toBe(0);
    expect(out.stderr).toBe('');
    expect(JSON.parse(out.stdout)).toEqual({ args: ['one', 'two'], secret: '' });
  });

  it('runs bundled scripts through an attached sandbox when available', async () => {
    const calls: { method: string; params?: Record<string, unknown> }[] = [];
    const set = buildSkillToolSet([pdfSkill], {
      sandboxDeploymentIds: ['sandbox-dep'],
      rpc: async (_id, method, params) => {
        calls.push({ method, params });
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });

    const out = await (set.skill_run_script.execute as ToolExec)({
      skill: 'pdf',
      path: 'scripts/echo.js',
      args: ['one'],
    });

    expect(out).toEqual({ content: [{ type: 'text', text: 'ok' }] });
    expect(calls.map((c) => (c.params?.name))).toEqual([
      'write_file',
      'write_file',
      'write_file',
      'process_exec',
    ]);
    expect(calls.at(-1)?.params).toMatchObject({
      name: 'process_exec',
      arguments: {
        runtime: 'node',
        args: ['scripts/echo.js', 'one'],
        cwd: '.toolplane/skills/pdf',
      },
    });
  });

  it('preserves binary skill files as base64 and decodes them in sandboxes', async () => {
    const calls: { method: string; params?: Record<string, unknown> }[] = [];
    const set = buildSkillToolSet([binarySkill], {
      sandboxDeploymentIds: ['sandbox-dep'],
      rpc: async (_id, method, params) => {
        calls.push({ method, params });
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });

    const list = (await (set.skill_list_attached.execute as ToolExec)({})) as {
      skills: { binaryFiles: string[] }[];
    };
    expect(list.skills[0].binaryFiles).toEqual(['assets/font.ttf']);

    const font = (await (set.skill_read_file.execute as ToolExec)({ skill: 'canvas', path: 'assets/font.ttf' })) as {
      content: string;
      encoding?: string;
    };
    expect(font).toMatchObject({ content: Buffer.from('font').toString('base64'), encoding: 'base64' });

    await (set.skill_run_script.execute as ToolExec)({
      skill: 'canvas',
      path: 'scripts/echo.js',
    });

    expect(calls.map((c) => (c.params?.name))).toEqual([
      'write_file',
      'write_file',
      'write_file',
      'process_exec',
    ]);
    expect(calls.at(2)?.params).toMatchObject({
      name: 'write_file',
      arguments: {
        path: '.toolplane/skills/canvas/assets/font.ttf',
        content: Buffer.from('font').toString('base64'),
        encoding: 'base64',
      },
    });
  });

  it('stops before execution when a sandbox file write fails', async () => {
    const calls: string[] = [];
    const set = buildSkillToolSet([pdfSkill], {
      sandboxDeploymentIds: ['sandbox-dep'],
      rpc: async (_id, _method, params) => {
        calls.push(String(params?.name));
        return params?.name === 'write_file'
          ? { isError: true, content: [{ type: 'text', text: 'disk full' }] }
          : { content: [{ type: 'text', text: 'unexpected' }] };
      },
    });

    const out = await (set.skill_run_script.execute as ToolExec)({
      skill: 'pdf',
      path: 'scripts/echo.js',
    });

    expect(out).toEqual({ error: expect.stringMatching(/disk full/) });
    expect(calls).toEqual(['write_file']);
  });
});
