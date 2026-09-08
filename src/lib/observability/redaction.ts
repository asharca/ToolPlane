const SECRET_KEY = /password|passwd|secret|token|authorization|cookie|credential|api[_-]?key|private[_-]?key|connectionstring|database[_-]?url/i;
const OMITTED = '[REDACTED]';

export function redactText(text: string, secrets: readonly string[] = []): string {
  for (const secret of [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length)) {
    text = text.replaceAll(secret, OMITTED);
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) text = text.replaceAll(escaped, OMITTED);
  }
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, OMITTED)
    .replace(/(\b(?:Bearer|Basic)\s+)[^\s,;"']+/gi, `$1${OMITTED}`)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${OMITTED}@`)
    .replace(/((?:password|passwd|secret|token|access_token|api[_-]?key|authorization|cookie|credential|client[_-]?secret)["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}\]]+)/gi, `$1"${OMITTED}"`)
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]+|sk-ant-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+)\b/g, OMITTED);
}

export function sanitizeLog(value: unknown, secrets: readonly string[] = [], maxBytes = 32_768) {
  let remaining = maxBytes;
  let truncated = false;
  const seen = new WeakSet<object>();
  const visit = (input: unknown, depth: number): unknown => {
    if (remaining < 64 || depth > 8) { truncated = true; return '[TRUNCATED]'; }
    remaining -= 32;
    if (input === null || input === undefined) return null;
    if (typeof input === 'string') {
      // Bound work as well as output; never keep a partially redacted huge value.
      if (input.length > maxBytes * 4) { truncated = true; return '[OVERSIZE]'; }
      const text = redactText(input, secrets);
      const bytes = Buffer.byteLength(text);
      if (bytes > remaining) { truncated = true; return '[TRUNCATED]'; }
      remaining -= bytes;
      return text;
    }
    if (typeof input === 'number') return Number.isFinite(input) ? input : null;
    if (typeof input === 'boolean') return input;
    if (typeof input === 'bigint') return String(input);
    if (typeof input !== 'object') return null;
    if (seen.has(input)) return '[CIRCULAR]';
    seen.add(input);
    if (input instanceof Error) {
      return visit({ name: input.name, message: input.message, stack: input.stack, cause: input.cause,
        code: 'code' in input ? input.code : undefined }, depth + 1);
    }
    if (input instanceof Date) return input.toISOString();
    if (Array.isArray(input)) {
      if (input.length > 100) truncated = true;
      return input.slice(0, 100).map((item) => visit(item, depth + 1));
    }
    const result: Record<string, unknown> = {};
    const entries = Object.entries(input);
    if (entries.length > 100) truncated = true;
    for (const [key, item] of entries.slice(0, 100)) {
      if (remaining < 64) { truncated = true; break; }
      const safeKey = redactText(key.slice(0, 160), secrets);
      remaining -= Buffer.byteLength(safeKey);
      const count = /^(?:input|output|total|cacheRead|cacheWrite|used|max)Tokens$/.test(key) && typeof item === 'number';
      Object.defineProperty(result, safeKey, { enumerable: true, writable: true, configurable: true, value: SECRET_KEY.test(key) && !count ? OMITTED : visit(item, depth + 1) });
    }
    return result;
  };
  const data = visit(value, 0);
  // Escaping can increase serialized bytes. Omit rather than produce invalid JSON.
  if (Buffer.byteLength(JSON.stringify(data)) > maxBytes) return { data: '[TRUNCATED]', truncated: true };
  return { data, truncated };
}
