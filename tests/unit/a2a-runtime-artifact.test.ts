import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const assembler = readFileSync(path.join(process.cwd(), 'scripts/assemble-runtime.mjs'), 'utf8');

describe('standalone A2A runtime packaging', () => {
  it('copies the complete SDK and its production dependency graph before checking artifact size', () => {
    const copy = assembler.indexOf("await copyRuntimePackage('@a2a-js/sdk');");
    expect(copy).toBeGreaterThan(-1);
    expect(copy).toBeLessThan(assembler.indexOf('const runtimeBytes ='));
    expect(assembler).toContain('Object.keys(manifest.dependencies ?? {})');
    expect(assembler).toContain('await copyRuntimePackage(dependency, dependencySource, dependencyTarget, nextAncestors)');
  });

  it('loads all HTTP protocol entry points from the assembled package, not the workspace SDK', () => {
    const smoke = assembler.slice(assembler.indexOf('const a2aSdkRoot ='), assembler.indexOf('await pruneNodePty(outputRoot)'));
    expect(smoke).toContain("path.join(outputRoot, 'node_modules/@a2a-js/sdk/dist')");
    for (const entry of ['index.js', 'client/index.js', 'server/index.js', 'errors/index.js']) {
      expect(smoke).toContain(`'${entry}'`);
      expect(assembler).toContain(`['node_modules/@a2a-js/sdk/dist/${entry}',`);
    }
    expect(smoke).toContain('import(pathToFileURL(path.join(a2aSdkRoot, entry)).href)');
    expect(smoke).not.toContain('catch');
  });
});
