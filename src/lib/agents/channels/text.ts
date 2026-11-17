// Adapted from Cherry Studio. See NOTICE for source and license.
export function clampSurrogateBoundary(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;
  const high = text.charCodeAt(index - 1);
  const low = text.charCodeAt(index);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff
    ? index - 1
    : index;
}

/** The latest part of a growing stream that fits one message, so progress stays visible. */
export function streamTail(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  // Two-char marker plus at most one extra unit when keeping a surrogate pair whole.
  const start = clampSurrogateBoundary(text, text.length - (maxLength - 3));
  return `…\n${text.slice(start)}`;
}
