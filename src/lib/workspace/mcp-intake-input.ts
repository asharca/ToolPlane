/**
 * Decide whether intake text is a search query (registry + presets) rather
 * than a configuration to analyze: URLs, JSON, install links and commands.
 */
const CONFIG_PREFIX =
  /^(?:(?:npx|uvx|uv|docker|claude|code)\s|(?:cursor|vscode|vscode-insiders):|[A-Za-z_][A-Za-z0-9_]*=)/;

export function isMcpSearchQuery(text: string): boolean {
  const value = text.trim();
  if (!value || value.length > 120 || /[\r\n{}"]/.test(value)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  return !CONFIG_PREFIX.test(value);
}
