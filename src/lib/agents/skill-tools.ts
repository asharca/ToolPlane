import 'server-only';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jsonSchema, tool, type ToolSet } from 'ai';
import { mcpRpc } from '@/lib/process/mcp-client';
import { buildInstalledSkillMarkdown, installedSkillExtraFiles } from '@/lib/skills/artifact';
import { safeSkillFilePath, type SkillBundleFile } from '@/lib/skills/bundle';
import { skillLabel } from '@/lib/workspace/skill-label';
import type { SkillForPrompt } from './resolve';

const SCRIPT_TIMEOUT_MS = 20_000;
const MAX_ARG_LENGTH = 2_000;
const MAX_STDIN_BYTES = 512_000;
const MAX_OUTPUT_BYTES = 64_000;

type RuntimeSkill = {
  slug: string;
  name: string;
  description: string | null;
  markdown: string;
  files: SkillBundleFile[];
};

function outputLimit(input: string): string {
  if (Buffer.byteLength(input, 'utf8') <= MAX_OUTPUT_BYTES) return input;
  return `${Buffer.from(input, 'utf8').subarray(0, MAX_OUTPUT_BYTES).toString('utf8')}\n[output truncated]`;
}

function buildSkillIndex(skills: SkillForPrompt[]): RuntimeSkill[] {
  return skills.map((s) => {
    const label = skillLabel({
      skillId: s.skillId,
      skill: s.skill,
      name: s.name ?? null,
      slug: s.slug ?? null,
      source: null,
    });
    return {
      slug: label.slug,
      name: label.name,
      description: s.skill?.description ?? s.description ?? null,
      markdown: buildInstalledSkillMarkdown(s),
      files: installedSkillExtraFiles(s),
    };
  });
}

function findSkill(skills: RuntimeSkill[], raw: unknown): RuntimeSkill | null {
  const key = String(raw ?? '').trim().toLowerCase();
  if (!key) return null;
  return skills.find((s) => s.slug.toLowerCase() === key || s.name.toLowerCase() === key) ?? null;
}

function readSkillPath(skill: RuntimeSkill, rawPath: unknown): SkillBundleFile | { error: string } {
  const requested = String(rawPath ?? '').trim() || 'SKILL.md';
  if (/^SKILL\.md$/i.test(requested)) return { path: 'SKILL.md', content: skill.markdown };
  const safePath = safeSkillFilePath(requested);
  if (!safePath) return { error: 'Invalid skill file path.' };
  const file = skill.files.find((f) => f.path === safePath);
  if (!file) return { error: `Skill file not found: ${safePath}` };
  return file;
}

function isRunnableScript(filePath: string): boolean {
  if (!filePath.startsWith('scripts/')) return false;
  return ['.js', '.mjs', '.cjs', '.py', '.sh'].includes(path.extname(filePath));
}

function commandForScript(absPath: string, filePath: string): { command: string; args: string[] } | null {
  const ext = path.extname(filePath);
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return { command: process.execPath, args: [absPath] };
  if (ext === '.py') return { command: 'python3', args: [absPath] };
  if (ext === '.sh') return { command: 'bash', args: [absPath] };
  return null;
}

function fileContentBuffer(file: SkillBundleFile): Buffer {
  return file.encoding === 'base64'
    ? Buffer.from(file.content, 'base64')
    : Buffer.from(file.content, 'utf8');
}

function sandboxProcessForScript(filePath: string, args: string[]): { runtime: 'node' | 'python' | 'bash'; args: string[] } | null {
  const ext = path.extname(filePath);
  const processArgs = [filePath, ...args];
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return { runtime: 'node', args: processArgs };
  if (ext === '.py') return { runtime: 'python', args: processArgs };
  if (ext === '.sh') return { runtime: 'bash', args: processArgs };
  return null;
}

async function materializeSkill(skill: RuntimeSkill): Promise<string> {
  const root = await mkdtemp(path.join(/* turbopackIgnore: true */ os.tmpdir(), 'toolplane-agent-skill-'));
  await writeFile(path.join(/* turbopackIgnore: true */ root, 'SKILL.md'), skill.markdown);
  for (const file of skill.files) {
    const safePath = safeSkillFilePath(file.path);
    if (!safePath) continue;
    const target = path.join(/* turbopackIgnore: true */ root, safePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, fileContentBuffer(file));
  }
  return root;
}

function minimalScriptEnv(root: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    NODE_ENV: process.env.NODE_ENV ?? 'production',
    HOME: root,
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    CI: '1',
    NO_COLOR: '1',
    PYTHONUNBUFFERED: '1',
  };
}

async function runScriptProcess({
  command,
  args,
  cwd,
  stdin,
}: {
  command: string;
  args: string[];
  cwd: string;
  stdin: string;
}): Promise<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn(command, args, {
      cwd,
      env: minimalScriptEnv(cwd),
      stdio: 'pipe',
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, SCRIPT_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = outputLimit(stdout + chunk.toString('utf8'));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = outputLimit(stderr + chunk.toString('utf8'));
    });
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, signal: null, timedOut, stdout, stderr: String(error.message) });
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, timedOut, stdout, stderr });
    });

    child.stdin.end(Buffer.from(stdin, 'utf8').subarray(0, MAX_STDIN_BYTES));
  });
}

async function callSandboxTool(
  rpc: typeof mcpRpc,
  deploymentId: string,
  name: string,
  args: Record<string, unknown>,
) {
  return rpc(deploymentId, 'tools/call', { name, arguments: args }, 120000);
}

function sandboxToolError(result: Record<string, unknown> | null): string | null {
  if (!result) return 'Sandbox is not reachable.';
  if (result.isError !== true) return null;
  const content = result.content;
  if (!Array.isArray(content)) return 'Sandbox operation failed.';
  const first = content[0] as { text?: unknown } | undefined;
  return typeof first?.text === 'string' ? first.text : 'Sandbox operation failed.';
}

async function writeSkillToSandbox(
  rpc: typeof mcpRpc,
  deploymentId: string,
  skill: RuntimeSkill,
  root: string,
): Promise<{ ok: true } | { error: string }> {
  const files: SkillBundleFile[] = [{ path: 'SKILL.md', content: skill.markdown }, ...skill.files];
  for (const file of files) {
    const targetPath = `${root}/${file.path}`;
    const writeResult = await callSandboxTool(rpc, deploymentId, 'write_file', {
      path: targetPath,
      content: file.content,
      encoding: file.encoding ?? 'utf8',
    });
    const error = sandboxToolError(writeResult);
    if (error) return { error: `Could not write ${file.path}: ${error}` };
  }
  return { ok: true };
}

export function buildSkillToolSet(
  skillsForPrompt: SkillForPrompt[],
  opts: { sandboxDeploymentIds?: string[]; rpc?: typeof mcpRpc } = {},
): ToolSet {
  const skills = buildSkillIndex(skillsForPrompt);
  if (skills.length === 0) return {};
  const skillNames = skills.map((s) => `${s.slug} (${s.name})`).join(', ');
  const sandboxDeploymentIds = opts.sandboxDeploymentIds ?? [];
  const rpc = opts.rpc ?? mcpRpc;

  return {
    skill_list_attached: tool({
      description: `List the active attached agent skills and their bundled files. Available skills: ${skillNames}`,
      inputSchema: jsonSchema({ type: 'object', properties: {} }),
      execute: async () => ({
        skills: skills.map((s) => ({
          slug: s.slug,
          name: s.name,
          description: s.description,
          files: ['SKILL.md', ...s.files.map((f) => f.path)],
          binaryFiles: s.files.filter((f) => f.encoding === 'base64').map((f) => f.path),
          runnableScripts: s.files.filter((f) => isRunnableScript(f.path)).map((f) => f.path),
        })),
      }),
    }),

    skill_read_file: tool({
      description:
        'Read SKILL.md or a bundled file from an attached agent skill. Use this when a skill references extra docs, examples, or scripts.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          skill: { type: 'string', description: `Attached skill slug or name. Available: ${skillNames}` },
          path: { type: 'string', description: 'File path, for example SKILL.md, reference.md, or scripts/tool.py.' },
        },
        required: ['skill', 'path'],
      }),
      execute: async ({ skill, path: filePath }: { skill: string; path: string }) => {
        const runtimeSkill = findSkill(skills, skill);
        if (!runtimeSkill) return { error: `Attached skill not found: ${String(skill)}` };
        const file = readSkillPath(runtimeSkill, filePath);
        if ('error' in file) return file;
        return { skill: runtimeSkill.slug, path: file.path, content: file.content, encoding: file.encoding };
      },
    }),

    skill_run_script: tool({
      description:
        'Run a bundled script from an attached skill. Only scripts/* files ending in .js, .mjs, .cjs, .py, or .sh are allowed. The script runs in a temporary skill folder with a minimal environment and no app secrets.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          skill: { type: 'string', description: `Attached skill slug or name. Available: ${skillNames}` },
          path: { type: 'string', description: 'Bundled script path under scripts/, for example scripts/convert.py.' },
          args: {
            type: 'array',
            items: { type: 'string' },
            description: 'Command-line arguments to pass to the script.',
          },
          sandboxDeploymentId: {
            type: 'string',
            description: 'Optional sandbox deployment id. Defaults to the first sandbox attached to the agent.',
          },
          stdin: { type: 'string', description: 'Optional standard input for the script.' },
        },
        required: ['skill', 'path'],
      }),
      execute: async ({
        skill,
        path: filePath,
        args = [],
        stdin = '',
        sandboxDeploymentId,
      }: {
        skill: string;
        path: string;
        args?: string[];
        stdin?: string;
        sandboxDeploymentId?: string;
      }) => {
        const runtimeSkill = findSkill(skills, skill);
        if (!runtimeSkill) return { error: `Attached skill not found: ${String(skill)}` };
        const file = readSkillPath(runtimeSkill, filePath);
        if ('error' in file) return file;
        if (!isRunnableScript(file.path)) {
          return { error: 'Only bundled scripts under scripts/ with .js, .mjs, .cjs, .py, or .sh extensions can run.' };
        }
        if (!Array.isArray(args) || args.some((a) => typeof a !== 'string' || a.length > MAX_ARG_LENGTH)) {
          return { error: 'Script args must be strings shorter than 2000 characters.' };
        }

        const targetSandbox = sandboxDeploymentId && sandboxDeploymentIds.includes(sandboxDeploymentId)
          ? sandboxDeploymentId
          : sandboxDeploymentIds[0];
        if (targetSandbox) {
          const root = `.toolplane/skills/${runtimeSkill.slug}`;
          const written = await writeSkillToSandbox(rpc, targetSandbox, runtimeSkill, root);
          if ('error' in written) return written;
          const processSpec = sandboxProcessForScript(file.path, args);
          if (!processSpec) return { error: `Unsupported script type: ${file.path}` };
          const result = await callSandboxTool(rpc, targetSandbox, 'process_exec', {
            runtime: processSpec.runtime,
            args: processSpec.args,
            cwd: root,
            stdin,
            timeoutMs: SCRIPT_TIMEOUT_MS,
          });
          return result ?? { error: `Sandbox ${targetSandbox} is not reachable.` };
        }

        let root: string | null = null;
        try {
          root = await materializeSkill(runtimeSkill);
          const absPath = path.join(/* turbopackIgnore: true */ root, file.path);
          const command = commandForScript(absPath, file.path);
          if (!command) return { error: `Unsupported script type: ${file.path}` };
          return await runScriptProcess({
            command: command.command,
            args: [...command.args, ...args],
            cwd: root,
            stdin,
          });
        } finally {
          if (root) await rm(root, { recursive: true, force: true });
        }
      },
    }),
  };
}
