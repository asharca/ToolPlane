import { z } from 'zod';

const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const PYPI_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const GITHUB_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/;
const DOCKER_IMAGE = /^[a-z0-9]+([._/-][a-z0-9]+)*(:[\w.-]+)?$/;

export type McpSource = 'npm' | 'pypi' | 'github' | 'docker';

// Shared reference validator for a given source — reused by both the custom-MCP
// deploy form and the admin server-recipe parser so the rules can't drift.
export function isValidMcpRef(source: McpSource, ref: string): boolean {
  return source === 'npm' ? NPM_NAME.test(ref)
    : source === 'pypi' ? PYPI_NAME.test(ref)
    : source === 'github' ? GITHUB_URL.test(ref)
    : DOCKER_IMAGE.test(ref);
}

const schema = z
  .object({
    source: z.enum(['npm', 'pypi', 'github', 'docker']),
    ref: z.string().trim().min(1),
    name: z.string().trim().min(1, 'name is required').max(80),
    startCommand: z.string().trim().default(''),
  })
  .superRefine((v, ctx) => {
    if (!isValidMcpRef(v.source, v.ref))
      ctx.addIssue({ code: 'custom', path: ['ref'], message: `invalid ${v.source} reference` });
  });

export type ParsedCustomMcp = {
  source: 'npm' | 'pypi' | 'github' | 'docker';
  ref: string;
  name: string;
  installCfg: { startCommand: string } | null;
};

export function parseCustomMcpInput(raw: unknown): ParsedCustomMcp {
  const v = schema.parse(raw);
  const installCfg = v.source === 'docker' && v.startCommand ? { startCommand: v.startCommand } : null;
  return { source: v.source, ref: v.ref, name: v.name, installCfg };
}
