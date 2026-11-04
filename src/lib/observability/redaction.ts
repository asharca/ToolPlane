const SECRET_KEY =
  /password|passwd|secret|token|authorization|cookie|credential|api[_-]?key|private[_-]?key|connectionstring|database[_-]?url/i;
const OMITTED = "[REDACTED]";

export function redactText(
  text: string,
  secrets: readonly string[] = [],
): string {
  for (const secret of [...new Set(secrets.filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  )) {
    text = text.replaceAll(secret, OMITTED);
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) text = text.replaceAll(escaped, OMITTED);
  }
  return text
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      OMITTED,
    )
    .replace(/(\b(?:Bearer|Basic)\s+)[^\s,;"']+/gi, `$1${OMITTED}`)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${OMITTED}@`)
    .replace(
      /((?:password|passwd|secret|token|access_token|api[_-]?key|authorization|cookie|credential|client[_-]?secret)["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}\]]+)/gi,
      `$1"${OMITTED}"`,
    )
    .replace(
      /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]+|sk-ant-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+)\b/g,
      OMITTED,
    );
}

/** Preserves complete log values while replacing credentials and cyclic paths. */
export function sanitizeLog(value: unknown, secrets: readonly string[] = []) {
  type Frame = {
    input: object;
    source: Record<string, unknown> | unknown[];
    output: Record<string, unknown> | unknown[];
    keys: string[] | null;
    index: number;
  };
  const active = new WeakSet<object>();
  const frames: Frame[] = [];
  const convert = (input: unknown): unknown => {
    if (input === null || input === undefined) return null;
    if (typeof input === "string") return redactText(input, secrets);
    if (typeof input === "number") return Number.isFinite(input) ? input : null;
    if (typeof input === "boolean") return input;
    if (typeof input === "bigint") return String(input);
    if (typeof input !== "object") return null;
    if (active.has(input)) return "[CIRCULAR]";
    if (input instanceof Date) return input.toISOString();
    const source =
      input instanceof Error
        ? {
            name: input.name,
            message: input.message,
            stack: input.stack,
            cause: input.cause,
            code: "code" in input ? input.code : undefined,
          }
        : input;
    const array = Array.isArray(source);
    const output: Record<string, unknown> | unknown[] = array ? [] : {};
    active.add(input);
    frames.push({
      input,
      source: source as Record<string, unknown> | unknown[],
      output,
      keys: array ? null : Object.keys(source),
      index: 0,
    });
    return output;
  };
  const data = convert(value);
  // Only ancestors are active: shared references are copied, not called cycles.
  // Keeping traversal state on the heap also permits deeply nested protocol data.
  while (frames.length) {
    const frame = frames[frames.length - 1];
    if (
      frame.index >= (frame.keys?.length ?? (frame.source as unknown[]).length)
    ) {
      active.delete(frame.input);
      frames.pop();
      continue;
    }
    if (!frame.keys) {
      (frame.output as unknown[]).push(
        convert((frame.source as unknown[])[frame.index++]),
      );
      continue;
    }
    const key = frame.keys[frame.index++];
    const item = (frame.source as Record<string, unknown>)[key];
    const count =
      /^(?:input|output|total|cacheRead|cacheWrite|used|max)Tokens$/.test(
        key,
      ) && typeof item === "number";
    Object.defineProperty(frame.output, redactText(key, secrets), {
      enumerable: true,
      writable: true,
      configurable: true,
      value: SECRET_KEY.test(key) && !count ? OMITTED : convert(item),
    });
  }
  return { data, truncated: false };
}
