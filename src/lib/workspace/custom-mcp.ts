import { z } from 'zod';

const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const PYPI_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const GITHUB_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/;
const DOCKER_IMAGE = /^[a-z0-9]+([._/-][a-z0-9]+)*(:[\w.-]+)?$/;

const schema = z
  .object({
    source: z.enum(['npm', 'pypi', 'github', 'docker']),
    ref: z.string().trim().min(1),
    name: z.string().trim().min(1, 'name is required').max(80),
    startCommand: z.string().trim().default(''),
  })
  .superRefine((v, ctx) => {
    const ok =
      v.source === 'npm' ? NPM_NAME.test(v.ref)
      : v.source === 'pypi' ? PYPI_NAME.test(v.ref)
      : v.source === 'github' ? GITHUB_URL.test(v.ref)
      : DOCKER_IMAGE.test(v.ref);
    if (!ok) ctx.addIssue({ code: 'custom', path: ['ref'], message: `invalid ${v.source} reference` });
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
