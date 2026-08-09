const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function parseQuotedScalar(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value
        .slice(1, -1)
        .replace(/\\"/g, '"')
        .replace(/\\n/g, '\n')
        .replace(/\\\\/g, '\\');
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function blockIndent(lines: string[]): number {
  const indents = lines
    .filter((line) => line.trim())
    .map((line) => line.match(/^\s*/)?.[0].length ?? 0);
  return indents.length ? Math.min(...indents) : 0;
}

function parseBlockScalar(
  marker: string,
  rawLines: string[],
): string {
  const indent = blockIndent(rawLines);
  const lines = rawLines.map((line) => line.slice(Math.min(indent, line.length)));
  const folded = marker.startsWith('>');
  let value = folded
    ? lines.reduce((result, line, index) => {
        if (index === 0) return line;
        const previous = lines[index - 1];
        return `${result}${!previous.trim() || !line.trim() ? '\n' : ' '}${line}`;
      }, '')
    : lines.join('\n');

  if (marker.endsWith('-')) value = value.replace(/\n+$/, '');
  else if (!marker.endsWith('+')) value = `${value.replace(/\n+$/, '')}\n`;
  return value;
}

/**
 * Parse the small, string-valued YAML frontmatter surface used by Agent Skills.
 * This intentionally ignores nested objects and arrays, but correctly handles
 * quoted values and YAML literal/folded block scalars such as `description: |-`.
 */
export function parseSkillFrontmatter(content: string): Record<string, string> {
  const match = FRONTMATTER.exec(content);
  if (!match) return {};

  const lines = match[1].split(/\r?\n/);
  const result: Record<string, string> = {};

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || /^\s/.test(line) || line.trimStart().startsWith('#')) continue;
    const separator = line.indexOf(':');
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    if (!key) continue;
    const rawValue = line.slice(separator + 1).trim();

    if (/^[|>][+-]?$/.test(rawValue)) {
      const block: string[] = [];
      while (index + 1 < lines.length) {
        const candidate = lines[index + 1];
        if (candidate.trim() && !/^\s/.test(candidate)) break;
        block.push(candidate);
        index += 1;
      }
      result[key] = parseBlockScalar(rawValue, block);
      continue;
    }

    result[key] = parseQuotedScalar(rawValue);
  }

  return result;
}

export function normalizedSkillDescription(
  description: string | null | undefined,
  content?: string | null,
): string | null {
  const frontmatterDescription = content
    ? parseSkillFrontmatter(content).description?.trim()
    : '';
  if (frontmatterDescription) return frontmatterDescription;

  const value = description?.trim();
  if (!value || /^[|>][+-]?$/.test(value)) return null;
  return value.includes('\\"')
    ? value.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    : value;
}
