import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CONSOLE_ROOTS = [
  path.join(process.cwd(), 'src', 'app', 'app'),
  path.join(process.cwd(), 'src', 'app', 'admin'),
  path.join(process.cwd(), 'src', 'components', 'dashboard'),
] as const;

const PUBLIC_DIRECTORY_LITERAL = /["'`]\/(?:agents|server|tools\/skills)(?:[/?#"'`]|$)/g;
const PUBLIC_CARD_IMPORTS = [
  '@/components/cards/ServerCard',
  '@/components/cards/SkillCard',
  '@/components/cards/AgentCard',
  '@/components/agents/AgentMarketCard',
] as const;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [target] : [];
  });
}

describe('console marketplace link boundary', () => {
  it('does not link authenticated console or admin UI to public directory details', () => {
    const violations = CONSOLE_ROOTS.flatMap(sourceFiles).flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      const literals = Array.from(source.matchAll(PUBLIC_DIRECTORY_LITERAL), (match) => match[0]);
      const imports = PUBLIC_CARD_IMPORTS.filter((specifier) => source.includes(specifier));
      return [...literals, ...imports].map((value) => ({
        file: path.relative(process.cwd(), file),
        value,
      }));
    });

    expect(violations).toEqual([]);
  });
});
