import { z } from 'zod';

const GITHUB_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/.*)?$/;

const createSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(80),
  description: z.string().trim().max(280).default(''),
});

export function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
}

export function parseCreateSkill(raw: unknown): { name: string; description: string; slug: string } {
  const v = createSchema.parse(raw);
  return { name: v.name, description: v.description, slug: slugify(v.name) };
}

export function isGithubUrl(u: string): boolean {
  return GITHUB_URL.test(u.trim());
}

export function githubRawSkillUrl(repoUrl: string): string {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/.exec(repoUrl.trim());
  if (!m) throw new Error('invalid github url');
  return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/HEAD/SKILL.md`;
}
