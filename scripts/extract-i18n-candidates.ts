import path from 'path';
import ts from 'typescript';
import { fileURLToPath } from 'url';

export interface Candidate {
  file: string;
  line: number;
  text: string;
  type: 'jsxText' | 'jsxAttribute' | 'stringLiteral';
  attrName?: string;
}

const TEXT_ATTRIBUTES = new Set([
  // standard
  'label',
  'placeholder',
  'title',
  'aria-label',
  // buttons / actions
  'pendingLabel',
  'confirmText',
  'cancelText',
  'deleteText',
  'actionText',
  'retryText',
  'loadingText',
  'successText',
  'errorText',
  // custom content props observed in the codebase
  'lead',
  'tail',
  'subtitle',
  'description',
  'prompt',
  'savedLabel',
  'emptyText',
  'noResultsText',
  'helperText',
  'hint',
  'tooltip',
  'header',
  'footer',
  'cta',
  'alt',
]);

function isMeaningfulText(text: string): boolean {
  return /[a-zA-Z一-龥]/.test(text) && text.trim().length > 0;
}

function collectExpressionStrings(node: ts.Expression | undefined): string[] {
  if (!node) return [];
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return isMeaningfulText(node.text) ? [node.text] : [];
  }
  if (ts.isConditionalExpression(node)) {
    return [
      ...collectExpressionStrings(node.whenTrue),
      ...collectExpressionStrings(node.whenFalse),
    ];
  }
  if (ts.isBinaryExpression(node) && (
    node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
    node.operatorToken.kind === ts.SyntaxKind.BarBarToken
  )) {
    return [
      ...collectExpressionStrings(node.left),
      ...collectExpressionStrings(node.right),
    ];
  }
  if (ts.isParenthesizedExpression(node)) {
    return collectExpressionStrings(node.expression);
  }
  return [];
}

export function extractCandidatesFromSource(file: string, source: string): Candidate[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );

  function line(node: ts.Node): number {
    return sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  }

  function visit(node: ts.Node): Candidate[] {
    const own: Candidate[] = isJsxTextCandidate(node)
      ? [{ file, line: line(node), text: node.text.trim(), type: 'jsxText' }]
      : [];

    const attrCandidates = ts.isJsxAttribute(node)
      ? extractAttributeCandidates(node)
      : [];

    const exprCandidates = ts.isJsxExpression(node) && node.expression
      ? extractExpressionCandidates(node, node.expression)
      : [];

    const childCandidates = node
      .getChildren(sourceFile)
      .flatMap((child) => visit(child));

    return [...own, ...attrCandidates, ...exprCandidates, ...childCandidates];
  }

  function isJsxTextCandidate(node: ts.Node): node is ts.JsxText {
    if (!ts.isJsxText(node)) return false;
    const text = node.text.trim();
    return isMeaningfulText(text);
  }

  function extractAttributeCandidates(node: ts.JsxAttribute): Candidate[] {
    const attrName = node.name.getText(sourceFile);
    if (!TEXT_ATTRIBUTES.has(attrName) || !node.initializer) return [];

    if (ts.isStringLiteral(node.initializer)) {
      const text = node.initializer.text;
      return isMeaningfulText(text)
        ? [{ file, line: line(node), text, type: 'jsxAttribute', attrName }]
        : [];
    }

    if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
      return collectExpressionStrings(node.initializer.expression).map((text) => ({
        file,
        line: line(node),
        text,
        type: 'jsxAttribute' as const,
        attrName,
      }));
    }

    return [];
  }

  function extractExpressionCandidates(node: ts.JsxExpression, expression: ts.Expression): Candidate[] {
    // Catch strings inside JSX children expressions: {show ? 'Yes' : 'No'}, {`template`}
    const parent = node.parent;
    if (!ts.isJsxElement(parent) && !ts.isJsxFragment(parent)) return [];
    return collectExpressionStrings(expression).map((text) => ({
      file,
      line: line(node),
      text,
      type: 'stringLiteral' as const,
    }));
  }

  return visit(sourceFile);
}

export function extractCandidatesFromFiles(files: string[], readFile = ts.sys.readFile): Candidate[] {
  return files.flatMap((file) => {
    const content = readFile(file, 'utf8');
    if (content === undefined) {
      console.warn(`Warning: could not read file ${file}`);
      return [];
    }
    return extractCandidatesFromSource(file, content);
  });
}

// CLI entry point
if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('Usage: pnpm tsx scripts/extract-i18n-candidates.ts <file...>');
    process.exit(1);
  }
  const candidates = extractCandidatesFromFiles(files);
  console.log(JSON.stringify(candidates, null, 2));
}
