// Adapted from Cherry Studio. See NOTICE for source and license.
export function clampSurrogateBoundary(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;
  const high = text.charCodeAt(index - 1);
  const low = text.charCodeAt(index);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff ? index - 1 : index;
}
