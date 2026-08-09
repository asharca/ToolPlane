const DEFAULT_TITLE_LENGTH = 64;

function compactText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function conversationTitleFromParts(
  parts: unknown,
  maxLength = DEFAULT_TITLE_LENGTH,
): string | null {
  if (!Array.isArray(parts) || maxLength < 1) return null;

  const text = parts
    .filter((part): part is { type: string; text: string } => (
      typeof part === 'object'
      && part !== null
      && 'type' in part
      && part.type === 'text'
      && 'text' in part
      && typeof part.text === 'string'
    ))
    .map((part) => part.text)
    .find((value) => compactText(value).length > 0);
  if (!text) return null;

  const compact = compactText(text);
  const characters = Array.from(compact);
  if (characters.length <= maxLength) return compact;
  if (maxLength === 1) return '…';
  return `${characters.slice(0, maxLength - 1).join('').trimEnd()}…`;
}
