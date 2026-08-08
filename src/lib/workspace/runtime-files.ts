import 'server-only';
import { isUtf8 } from 'node:buffer';
import path from 'node:path';

// Runtime files are deliberately text-only. This is generous enough for JSON,
// YAML, TOML, INI, .env, PEM, and extension-less configuration while keeping
// the encrypted database representation and Docker staging path simple.
export const RUNTIME_FILE_MOUNT_PATH = '/toolplane/config';
export const MAX_RUNTIME_TEXT_FILES = 32;
export const MAX_RUNTIME_TEXT_FILE_BYTES = 512 * 1024;
export const MAX_RUNTIME_TEXT_FILES_BYTES = 2 * 1024 * 1024;
const MAX_RUNTIME_FILE_PATH_BYTES = 240;

export type RuntimeTextFileInput = {
  path: string;
  content: string;
};

export type ValidRuntimeTextFile = RuntimeTextFileInput & {
  size: number;
};

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * A POSIX-relative path beneath the single managed mount. We intentionally do
 * not gate extensions or MIME types: format is irrelevant as long as content
 * is text and the path cannot escape the managed directory.
 */
export function safeRuntimeFilePath(raw: string): string | null {
  if (typeof raw !== 'string' || !raw || raw !== raw.trim()) return null;
  if (
    raw.includes('\\')
    || raw.includes('\0')
    || hasUnpairedSurrogate(raw)
    || /[\u0001-\u001f\u007f]/.test(raw)
  ) return null;
  const normalized = raw.normalize('NFC');
  if (
    normalized.startsWith('/')
    || Buffer.byteLength(normalized, 'utf8') > MAX_RUNTIME_FILE_PATH_BYTES
  ) return null;
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  // Resolve purely as a defense-in-depth check; this value is never accepted
  // as a user-controlled Docker mount target.
  const resolved = path.posix.resolve(RUNTIME_FILE_MOUNT_PATH, normalized);
  if (!resolved.startsWith(`${RUNTIME_FILE_MOUNT_PATH}/`)) return null;
  return normalized;
}

// Docker volumes are case-sensitive, but preventing portable collisions keeps
// a deployment deterministic across client operating systems and avoids two
// apparent versions of the same configuration file.
export function runtimeFilePathKey(filePath: string): string {
  const safe = safeRuntimeFilePath(filePath);
  if (!safe) throw new Error('Invalid runtime file path.');
  return safe.toLocaleLowerCase('en-US');
}

export function isPlainText(value: string): boolean {
  return typeof value === 'string'
    && !value.includes('\0')
    && !hasUnpairedSurrogate(value);
}

export function decodeRuntimeTextFile(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes);
  if (!isUtf8(buffer) || buffer.includes(0)) {
    throw new Error('Runtime files must be valid UTF-8 text and cannot contain NUL bytes.');
  }
  return buffer.toString('utf8');
}

export function validateRuntimeTextFiles(value: unknown): ValidRuntimeTextFile[] {
  if (!Array.isArray(value)) throw new Error('Runtime files must be an array.');
  if (value.length > MAX_RUNTIME_TEXT_FILES) {
    throw new Error(`A deployment can have at most ${MAX_RUNTIME_TEXT_FILES} runtime files.`);
  }

  const files: ValidRuntimeTextFile[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Each runtime file must have a path and text content.');
    }
    const record = raw as Record<string, unknown>;
    const filePath = typeof record.path === 'string' ? safeRuntimeFilePath(record.path) : null;
    const content = record.content;
    if (!filePath || typeof content !== 'string' || !isPlainText(content)) {
      throw new Error('Runtime files require a safe relative path and UTF-8 text content.');
    }
    const size = Buffer.byteLength(content, 'utf8');
    if (size > MAX_RUNTIME_TEXT_FILE_BYTES) {
      throw new Error(`Runtime file ${filePath} exceeds ${MAX_RUNTIME_TEXT_FILE_BYTES} bytes.`);
    }
    totalBytes += size;
    if (totalBytes > MAX_RUNTIME_TEXT_FILES_BYTES) {
      throw new Error(`Runtime files exceed ${MAX_RUNTIME_TEXT_FILES_BYTES} bytes in total.`);
    }
    const key = runtimeFilePathKey(filePath);
    if (seen.has(key)) throw new Error(`Duplicate runtime file path: ${filePath}.`);
    seen.add(key);
    files.push({ path: filePath, content, size });
  }
  return files;
}

export function parseRuntimeTextFiles(raw: unknown): ValidRuntimeTextFile[] {
  if (raw === undefined || raw === null || raw === '') return [];
  if (typeof raw !== 'string') throw new Error('Runtime files must be submitted as JSON.');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Runtime files must contain valid JSON.');
  }
  return validateRuntimeTextFiles(value);
}

export function runtimeFileContainerPath(filePath: string): string {
  const safe = safeRuntimeFilePath(filePath);
  if (!safe) throw new Error('Invalid runtime file path.');
  return path.posix.join(RUNTIME_FILE_MOUNT_PATH, safe);
}
