export type SandboxFileEntry = {
  name: string;
  type: 'dir' | 'file';
  size: number | null;
};

export type SandboxDirectoryListing = {
  path: string;
  entries: SandboxFileEntry[];
};

function normalizeSandboxPath(path: unknown): string {
  if (typeof path !== 'string') return '.';
  const clean = path.replace(/\\/g, '/').replace(/^\/workspace\/?/, '').replace(/^\/+/, '').trim();
  return clean || '.';
}

function parseLsLine(line: string): SandboxFileEntry | null {
  const match = line.match(/^([bcdlps-])[rwxstST-]{9}\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\d+\s+(?:\d{2}:\d{2}|\d{4})\s+(.+)$/);
  if (!match) return null;
  const name = match[3]?.split(' -> ')[0]?.trim();
  if (!name || name === '.' || name === '..') return null;
  return {
    name,
    type: match[1] === 'd' ? 'dir' : 'file',
    size: Number(match[2]) || null,
  };
}

function parseLsOutput(stdout: string, path: string): SandboxDirectoryListing {
  const entries = stdout
    .split('\n')
    .map((line) => parseLsLine(line.trim()))
    .filter((entry): entry is SandboxFileEntry => entry !== null);
  return { path, entries };
}

function parseStructuredListing(value: unknown, fallbackPath: string): SandboxDirectoryListing | null {
  const parsed = value as { path?: unknown; entries?: unknown };
  if (!Array.isArray(parsed.entries)) return null;
  const entries = parsed.entries
    .map((entry) => {
      const item = entry as { name?: unknown; type?: unknown; size?: unknown };
      if (typeof item.name !== 'string') return null;
      return {
        name: item.name,
        type: item.type === 'dir' ? 'dir' : 'file',
        size: typeof item.size === 'number' ? item.size : null,
      } satisfies SandboxFileEntry;
    })
    .filter((entry): entry is SandboxFileEntry => entry !== null);
  return { path: typeof parsed.path === 'string' ? normalizeSandboxPath(parsed.path) : fallbackPath, entries };
}

export function parseSandboxDirectoryText(text: string, fallbackPath = '.'): SandboxDirectoryListing | null {
  const path = normalizeSandboxPath(fallbackPath);
  try {
    const parsed = JSON.parse(text) as unknown;
    const structured = parseStructuredListing(parsed, path);
    if (structured) return structured;
    const maybeShell = parsed as { stdout?: unknown; path?: unknown };
    if (typeof maybeShell.stdout === 'string') {
      return parseLsOutput(
        maybeShell.stdout,
        typeof maybeShell.path === 'string' ? normalizeSandboxPath(maybeShell.path) : path,
      );
    }
  } catch {
    return null;
  }
  return null;
}
