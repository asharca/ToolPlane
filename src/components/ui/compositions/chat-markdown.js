// Application composition port from @asharca/ui@0.2.1 (MIT). See NOTICE.md.
const mermaidFencePattern = /(?:^|\n)[ \t>]*(?:[*+-][ \t]+|\d{1,9}[.)][ \t]+)?(?:`{3,}|~{3,})[ \t]*mermaid\b/i;
export function hasMermaidFence(markdown) {
    return mermaidFencePattern.test(markdown);
}
