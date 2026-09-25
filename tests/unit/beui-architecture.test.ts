// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.posix.join(directory, entry.name);
    return entry.isDirectory() ? files(target) : [target];
  });
}
describe('platform UI source ownership', () => {
  it('has no retired runtime dependency, package aliases or application imports', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.dependencies["@asharca/ui"]).toBeUndefined();
    expect(readFileSync('tsconfig.json', 'utf8')).not.toContain('"@asharca/ui"');
    const offenders: string[] = [];
    for (const file of files('src').filter(f => /\.[jt]sx?$/.test(f))) {
      const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith("@asharca/ui")) offenders.push(file);
        ts.forEachChild(node, visit);
      };
      visit(ast);
    }
    expect(offenders).toEqual([]);
  });
  it('routes application form controls through the common adapters', () => {
    const offenders: string[] = [];
    for (const file of files('src').filter(f => f.endsWith('.tsx') && !f.startsWith('src/components/ui/'))) {
      const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (node: ts.Node) => {
        if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ['button', 'input', 'textarea', 'select', 'table'].includes(node.tagName.getText(ast))) offenders.push(`${file}:${ast.getLineAndCharacterOfPosition(node.pos).line + 1}`);
        ts.forEachChild(node, visit);
      };
      visit(ast);
    }
    expect(offenders).toEqual([]);
  });
  it('leaves the main landmark with the dashboard host, not nested feature panes', () => {
    for (const file of ["src/components/dashboard/knowledge/WorkspaceKnowledge.tsx", "src/components/dashboard/work/WorkspaceWork.tsx", "src/components/dashboard/work/A2AWorkbench.tsx", "src/components/dashboard/market/MarketDetailShell.tsx", "src/app/app/[workspace]/market/mcp/[serverSlug]/page.tsx"]) {
      const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const landmarks: string[] = [];
      const visit = (node: ts.Node) => {
        if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(ast) === 'main') landmarks.push(file);
        ts.forEachChild(node, visit);
      };
      visit(ast);
      expect(landmarks).toEqual([]);
    }
  });
  it('records the requested registry and preserves reduced-motion and forced-color handling', () => {
    const manifest = JSON.parse(readFileSync('src/components/ui/beui/provenance.json', 'utf8'));
    expect(manifest.source).toBe('https://asharca.github.io/ui/llms.txt');
    expect(manifest.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(manifest.files.length).toBeGreaterThanOrEqual(4);
    const css = readFileSync('src/components/ui/beui-overrides.css', 'utf8');
    expect(css).toContain('prefers-reduced-motion: reduce');
    expect(css).toContain('forced-colors: active');
    expect(readFileSync('src/components/ui/composition-layout.css', 'utf8')).not.toContain('--toolplane-ui-background');
  });
});
