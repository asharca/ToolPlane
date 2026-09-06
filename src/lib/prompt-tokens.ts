export function estimatePromptTokens(prompt: string): number {
  const text = prompt.trim();
  if (!text) return 0;
  const cjkCharacters = text.match(/[\u3000-\u9fff\uf900-\ufaff\uac00-\ud7af]/g)?.length ?? 0;
  const otherCharacters = text.replace(/[\u3000-\u9fff\uf900-\ufaff\uac00-\ud7af]/g, '');
  return cjkCharacters + Math.ceil(otherCharacters.length / 4);
}
