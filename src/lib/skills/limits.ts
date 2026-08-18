export const MAX_SKILL_FILES = 160;
export const MAX_SKILL_FILE_BYTES = 2_000_000;
export const MAX_SKILL_BUNDLE_BYTES = 12_000_000;
export const MAX_SKILL_IMPORT_FILES = 512;
export const MAX_SKILL_IMPORT_BYTES = 48_000_000;
export const MIN_SKILL_IMPORT_SKILLS = 1;
export const DEFAULT_SKILL_IMPORT_SKILLS = 64;
export const MAX_SKILL_IMPORT_SKILLS = MAX_SKILL_IMPORT_FILES;

export function isValidSkillImportMaxSkills(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= MIN_SKILL_IMPORT_SKILLS
    && value <= MAX_SKILL_IMPORT_SKILLS;
}

export const TEXT_SKILL_EXTENSIONS = [
  '.bash',
  '.cjs',
  '.css',
  '.csv',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.py',
  '.sh',
  '.svg',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
  '.xsd',
] as const;

export const TEXT_SKILL_EXTENSION_SET = new Set<string>(TEXT_SKILL_EXTENSIONS);
