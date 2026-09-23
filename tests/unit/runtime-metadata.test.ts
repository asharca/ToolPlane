// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, symlink, lstat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pruneMigrationMetadata } from '../../scripts/runtime-metadata.mjs';

let temporary = '';
afterEach(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
  temporary = '';
});

describe('isolated migration metadata pruning', () => {
  it('removes only declarations and source maps, preserving executable and engine files', async () => {
    temporary = await mkdtemp(path.join(tmpdir(), 'runtime-metadata-'));
    const root = path.join(temporary, 'node_modules');
    const nested = path.join(root, '.pnpm', 'fixture', 'node_modules', 'fixture');
    await mkdir(nested, { recursive: true });
    const metadata = ['index.d.ts', 'index.d.mts', 'index.d.cts', 'index.js.map', 'index.cjs.map', 'index.mjs.map', 'index.d.ts.map', 'style.css.map'];
    const runtime = ['index.js', 'index.cjs', 'index.mjs', 'config.ts', 'schema-engine-debian-openssl-3.0.x', 'schema.wasm', 'data.map', 'package.json', 'LICENSE'];
    for (const name of [...metadata, ...runtime]) {
      await writeFile(path.join(nested, name), `fixture:${name}`);
    }
    const result = await pruneMigrationMetadata(root);
    expect(result.files).toBe(metadata.length);
    expect(result.bytes).toBe(metadata.reduce((bytes, name) => bytes + Buffer.byteLength(`fixture:${name}`), 0));
    for (const name of metadata) await expect(lstat(path.join(nested, name))).rejects.toMatchObject({ code: 'ENOENT' });
    for (const name of runtime) expect(await readFile(path.join(nested, name), 'utf8')).toBe(`fixture:${name}`);
    await expect(pruneMigrationMetadata(root)).resolves.toEqual({ files: 0, bytes: 0 });
  });

  it('does not follow directory or file symlinks outside the copied migrator', async () => {
    temporary = await mkdtemp(path.join(tmpdir(), 'runtime-metadata-links-'));
    const root = path.join(temporary, 'node_modules');
    const outside = path.join(temporary, 'source-store');
    await mkdir(root);
    await mkdir(outside);
    await writeFile(path.join(outside, 'index.d.ts'), 'source declaration');
    await symlink(outside, path.join(root, 'external'), 'dir');
    await symlink(path.join(outside, 'index.d.ts'), path.join(root, 'linked.d.ts'));
    await expect(pruneMigrationMetadata(root)).resolves.toEqual({ files: 0, bytes: 0 });
    expect(await readFile(path.join(outside, 'index.d.ts'), 'utf8')).toBe('source declaration');
    expect((await lstat(path.join(root, 'linked.d.ts'))).isSymbolicLink()).toBe(true);
    await expect(pruneMigrationMetadata(path.join(root, 'external'))).rejects.toThrow('real directory');
  });

  it('validates the packaged migration CLI before calculating its size', async () => {
    const assembler = await readFile(path.join(process.cwd(), 'scripts/assemble-runtime.mjs'), 'utf8');
    const validation = assembler.indexOf("await run(path.join(outputRoot, 'node_modules', '.bin', 'prisma'), ['validate']");
    expect(validation).toBeGreaterThan(assembler.indexOf('await pruneMigrationMetadata('));
    expect(validation).toBeLessThan(assembler.indexOf('const runtimeBytes ='));
    expect(assembler).toContain("path.join(embeddedRuntimeRoot, 'migrator', 'node_modules')");
    expect(assembler).toContain("CHECKPOINT_DISABLE: '1'");
  });
});
