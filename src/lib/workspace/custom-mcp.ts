import { z } from 'zod';

const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

const schema = z.object({
  source: z.literal('npm'),
  packageRef: z.string().trim().min(1).regex(NPM_NAME, 'invalid npm package name'),
  name: z.string().trim().min(1, 'name is required').max(80),
  env: z
    .array(z.object({ key: z.string().regex(ENV_KEY, 'invalid env var name'), value: z.string() }))
    .default([]),
  args: z.string().default(''),
});

export type ParsedCustomMcp = {
  source: 'npm';
  packageRef: string;
  name: string;
  installCfg: { env: Record<string, string>; args: string[] };
};

export function parseCustomMcpInput(raw: unknown): ParsedCustomMcp {
  const v = schema.parse(raw);
  const env: Record<string, string> = {};
  for (const row of v.env) env[row.key] = row.value;
  const args = v.args.split(/\s+/).filter(Boolean);
  return { source: v.source, packageRef: v.packageRef, name: v.name, installCfg: { env, args } };
}
