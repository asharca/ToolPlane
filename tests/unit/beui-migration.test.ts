// @vitest-environment node
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { migrateSource } from '../../scripts/ui/migrate-beui.mjs';

describe('source registry migration', () => {
  it('preserves directive order, callback expressions, spread semantics and closing tags', () => {
    const input = `'use client';\nexport const View = ({props}) => <button {...props} onClick={() => send()}><input name="q" /></button>;`;
    const result = migrateSource(input, 'View.tsx');
    expect(result.indexOf("'use client'")).toBeLessThan(result.indexOf('import'));
    expect(result).toContain('<BeuiButton nativeButton unstyled {...props} onClick={() => send()}');
    expect(result).toContain('</BeuiButton>'); expect(result).toContain('<BeuiInput name="q" />');
    expect(ts.transpileModule(result, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX }, reportDiagnostics: true }).diagnostics).toEqual([]);
  });
  it('avoids local collisions and does not rename unrelated literal text', () => {
    const result = migrateSource(`const BeuiButton = 1; const word = 'button'; export const A = () => <button>{word}</button>;`, 'A.tsx');
    expect(result).toContain('Button as BeuiButton_'); expect(result).toContain("const word = 'button'");
  });
  it('splits Radix imports without losing aliases, type imports or nonvisual primitives', () => {
    const result = migrateSource(`import { Slot, type Popover as P, Dialog as D } from 'radix-ui';`, 'A.tsx');
    expect(result).toContain("import { type Popover as P, Dialog as D } from '@/components/ui/primitives';");
    expect(result).toContain("import { Slot } from 'radix-ui';");
  });
  it('changes the retired package path explicitly instead of aliasing its identity', () => {
    expect(migrateSource(`export { Input } from '@asharca/ui/controls';`, 'A.ts')).toContain('"@/components/ui/Controls"');
  });
  it('does not rewrite policy checks or package names outside module specifiers', () => {
    const source = `const name = '@asharca/ui'; expect(pkg.dependencies['@asharca/ui']).toBeUndefined();`;
    expect(migrateSource(source, 'policy.test.ts')).toBe(source);
    expect(migrateSource(`vi.mock('@asharca/ui');`, 'mock.test.ts')).toContain(`vi.mock("@/components/ui");`);
  });
  it('is idempotent for migrated application files', () => {
    const once = migrateSource(`'use client'; export const A = () => <button><select><option>A</option></select></button>;`, 'A.tsx');
    expect(migrateSource(once, 'A.tsx')).toBe(once);
  });
  it('rewires compiled composition controls while preserving callback code', () => {
    const result = migrateSource(`'use client'; const A = () => _jsx("button", Object.assign({}, props, { onDragStart: start }));`, 'A.js', { legacyComposition: true });
    expect(result).toContain('_jsx(BeuiButton, Object.assign({ nativeButton: true, unstyled: true }, Object.assign({}, props, { onDragStart: start })))');
  });
});
