import { Buffer } from 'node:buffer';
import type { SkillReleaseManifestV1 } from '@/lib/market/skill-manifest';

const SECRET_PATTERNS = [
  ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['openai_key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['github_token', /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/],
  ['slack_token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ['aws_access_key', /\bAKIA[0-9A-Z]{16}\b/],
  ['google_api_key', /\bAIza[0-9A-Za-z_-]{30,}\b/],
] as const;

export type MarketSecretScan = {
  version: 1;
  status: 'passed' | 'blocked';
  findings: Array<{ kind: string; path: string }>;
};

type ScannedText = { path: string; content: string };

function textFields(value: unknown, path: string): ScannedText[] {
  if (typeof value === 'string') return [{ path, content: value }];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => textFields(item, `${path}[${index}]`));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([name, item]) => textFields(item, `${path}.${name}`));
  }
  return [];
}

export function scanMarketArtifact(
  manifest: unknown,
  releaseNotes?: string | null,
  extraText: ScannedText[] = [],
): MarketSecretScan {
  const findings = [
    ...textFields(manifest, 'manifest'),
    { path: 'releaseNotes', content: releaseNotes ?? '' },
    ...extraText,
  ].flatMap(({ path, content }) => SECRET_PATTERNS
    .filter(([, pattern]) => pattern.test(content))
    .map(([kind]) => ({ kind, path })));
  return { version: 1, status: findings.length ? 'blocked' : 'passed', findings };
}

export function scanSkillReleaseManifest(
  manifest: SkillReleaseManifestV1,
  releaseNotes?: string | null,
): MarketSecretScan {
  return scanMarketArtifact(manifest, releaseNotes, manifest.skill.files.flatMap((file, index) => file.encoding === 'base64' ? [{
    path: `manifest.skill.files[${index}].content(decoded)`,
    content: Buffer.from(file.content, 'base64').toString('utf8'),
  }] : []));
}

export function scanAgentReleaseManifest<T extends {
    skills: Array<{ files: Array<{ content: string; encoding?: 'base64' }> }>;
  }>(
  manifest: T,
  releaseNotes?: string | null,
): MarketSecretScan {
  return scanMarketArtifact(manifest, releaseNotes, manifest.skills.flatMap((skill, skillIndex) => (
    skill.files.flatMap((file, fileIndex) => file.encoding === 'base64' ? [{
      path: `manifest.skills[${skillIndex}].files[${fileIndex}].content(decoded)`,
      content: Buffer.from(file.content, 'base64').toString('utf8'),
    }] : [])
  )));
}
