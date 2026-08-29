import 'server-only';

import { z } from 'zod';
import { marketReleaseChecksum } from '@/lib/market/artifact';
import {
  buildInstalledSkillMarkdown,
  installedSkillExtraFiles,
} from '@/lib/skills/artifact';
import { normalizeSkillFiles } from '@/lib/skills/bundle';
import {
  MAX_SKILL_BUNDLE_BYTES,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILES,
} from '@/lib/skills/limits';
import { normalizedSkillDescription } from '@/lib/skills/frontmatter';
import { skillLabel } from '@/lib/workspace/skill-label';

export const SKILL_MARKET_MANIFEST_VERSION = 1 as const;

const skillFileSchema = z.object({
  path: z.string().min(1).max(240),
  content: z.string().max(Math.ceil(MAX_SKILL_FILE_BYTES * 4 / 3) + 4),
  encoding: z.literal('base64').optional(),
}).strict();

const skillReleaseListingSchema = z.object({
  slug: z.string().min(1).max(100),
  name: z.string().min(1).max(240),
  summary: z.string().max(4_000).nullable(),
  iconUrl: z.string().max(2_000).nullable(),
  tags: z.array(z.string().min(1).max(40)).max(20),
  author: z.string().min(1).max(240),
}).strict();

const skillReleaseManifestSchema = z.object({
  schemaVersion: z.literal(SKILL_MARKET_MANIFEST_VERSION),
  kind: z.literal('skill'),
  listing: skillReleaseListingSchema.optional(),
  skill: z.object({
    name: z.string().min(1).max(240),
    slug: z.string().min(1).max(120),
    description: z.string().max(4_000).nullable(),
    content: z.string().min(1).max(MAX_SKILL_FILE_BYTES),
    files: z.array(skillFileSchema).max(MAX_SKILL_FILES - 1),
    userInvocable: z.boolean(),
    agentInvocable: z.boolean(),
    effort: z.string().min(1).max(64),
    source: z.object({
      type: z.enum(['catalog', 'custom', 'github', 'upload', 'market']),
      reference: z.string().min(1).max(2_000).optional(),
      revision: z.string().min(1).max(240).optional(),
    }).strict(),
  }).strict(),
}).strict();

export type SkillReleaseManifestV1 = z.infer<typeof skillReleaseManifestSchema>;
export type SkillReleaseListingV1 = z.infer<typeof skillReleaseListingSchema>;

export type SkillReleaseSource = {
  skillId: string | null;
  name: string | null;
  slug: string | null;
  description: string | null;
  content: string | null;
  files: unknown;
  source: string | null;
  sourceRef: string | null;
  userInvocable: boolean;
  agentInvocable: boolean;
  effort: string;
  skill: null | {
    name: string;
    slug: string;
    description: string | null;
    author: string | null;
    content: string | null;
    files: unknown;
    githubSource: string | null;
    sourceSha: string | null;
  };
};

function sourceType(value: string): 'catalog' | 'custom' | 'github' | 'upload' | 'market' {
  if (value === 'agent-market') return 'market';
  return ['custom', 'github', 'upload', 'market'].includes(value)
    ? value as 'custom' | 'github' | 'upload' | 'market'
    : 'catalog';
}

export function buildSkillReleaseManifest(
  source: SkillReleaseSource,
  listing?: SkillReleaseListingV1,
): SkillReleaseManifestV1 {
  const label = skillLabel(source);
  const content = buildInstalledSkillMarkdown(source).trim();
  if (!content) throw new Error('A market skill release requires SKILL.md content.');
  const type = sourceType(source.source ?? label.source);
  const reference = source.skill?.githubSource || source.sourceRef || undefined;
  const revision = source.skill?.sourceSha || undefined;
  return parseSkillReleaseManifest({
    schemaVersion: SKILL_MARKET_MANIFEST_VERSION,
    kind: 'skill',
    ...(listing ? { listing } : {}),
    skill: {
      name: label.name,
      slug: label.slug,
      description: normalizedSkillDescription(
        source.description ?? source.skill?.description,
        content,
      ),
      content,
      files: installedSkillExtraFiles(source),
      userInvocable: source.userInvocable,
      agentInvocable: source.agentInvocable,
      effort: source.effort,
      source: {
        type,
        ...(reference ? { reference } : {}),
        ...(revision ? { revision } : {}),
      },
    },
  });
}

export function parseSkillReleaseManifest(
  raw: unknown,
  expectedChecksum?: string,
): SkillReleaseManifestV1 {
  const parsed = skillReleaseManifestSchema.safeParse(raw);
  if (!parsed.success) throw new Error('The skill release manifest is invalid.');
  const normalizedFiles = normalizeSkillFiles(parsed.data.skill.files);
  if (
    normalizedFiles.length !== parsed.data.skill.files.length
    || JSON.stringify(normalizedFiles) !== JSON.stringify(parsed.data.skill.files)
  ) {
    throw new Error('The skill release contains invalid files.');
  }
  if (Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') > MAX_SKILL_BUNDLE_BYTES) {
    throw new Error('The skill release manifest is too large.');
  }
  if (expectedChecksum && skillReleaseChecksum(parsed.data) !== expectedChecksum) {
    throw new Error('The skill release checksum does not match.');
  }
  return parsed.data;
}

export function skillReleaseChecksum(manifest: SkillReleaseManifestV1): string {
  return marketReleaseChecksum(manifest);
}
