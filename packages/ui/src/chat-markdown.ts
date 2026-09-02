const mermaidFencePattern = /(?:^|\n)[ \t>]*(?:[*+-][ \t]+|\d{1,9}[.)][ \t]+)?(?:`{3,}|~{3,})[ \t]*mermaid\b/i;

export function hasMermaidFence(markdown: string) {
  return mermaidFencePattern.test(markdown);
}
