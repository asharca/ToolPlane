import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readRepoFile(file: string) {
  return readFileSync(path.join(process.cwd(), file), 'utf8');
}

describe('minimal runtime artifact contract', () => {
  it('builds a Next standalone runtime instead of shipping the workspace dependency tree', () => {
    const nextConfig = readRepoFile('next.config.ts');
    const packageJson = JSON.parse(readRepoFile('package.json')) as {
      scripts?: Record<string, string>;
    };
    const releaseWorkflow = readRepoFile('.github/workflows/release-please.yml');
    const ciWorkflow = readRepoFile('.github/workflows/ci.yml');
    const dockerfile = readRepoFile('Dockerfile');
    const runtimeAssembler = readRepoFile('scripts/assemble-runtime.mjs');

    expect(nextConfig).toContain("output: 'standalone'");
    expect(packageJson.scripts?.['runtime:assemble']).toBe('node scripts/assemble-runtime.mjs');
    expect(releaseWorkflow).toContain('target: runtime-artifact');
    expect(releaseWorkflow.match(/platforms: linux\/amd64/g)).toHaveLength(2);
    expect(releaseWorkflow.indexOf('Export runtime release artifact')).toBeLessThan(
      releaseWorkflow.indexOf('Build and push release image'),
    );
    expect(releaseWorkflow).not.toMatch(/cp -a \\\n\s+node_modules/);
    expect(ciWorkflow).toContain('pnpm runtime:assemble');
    expect(ciWorkflow).toContain('dist/release/app/node_modules/.bin/prisma validate');
    expect(dockerfile).toContain('pnpm runtime:assemble');
    expect(dockerfile).toContain('/app/dist/release/app/');
    expect(dockerfile.match(/\/app\/node_modules \.\/node_modules/g)).toHaveLength(1);
    expect(runtimeAssembler).toContain('writeLegacyEntrypointShims(outputRoot)');
    expect(runtimeAssembler).toContain("['node_modules/.bin/prisma', 'legacy entrypoint Prisma shim']");
    expect(runtimeAssembler).toContain("['node_modules/.bin/next', 'legacy entrypoint Next shim']");
    expect(runtimeAssembler).toContain(
      "['node_modules/.toolplane-runtime/server.cjs', 'embedded standalone launcher']",
    );
    expect(runtimeAssembler).toContain('exec env HOSTNAME="0.0.0.0"');
    expect(runtimeAssembler).toContain('rm -rf "$APP_ROOT/.toolplane-update"/backup-*');
  });

  it('starts the assembled server and its isolated migration tool', () => {
    const entrypoint = readRepoFile('docker-entrypoint.sh');

    expect(entrypoint).toContain(
      'node_modules/.toolplane-runtime/migrator/node_modules/.bin/prisma migrate deploy',
    );
    expect(entrypoint).toContain('exec node node_modules/.toolplane-runtime/server.cjs');
    expect(entrypoint).not.toContain('node_modules/.bin/next start');
  });

  it('keeps first-upgrade boot files inside entries managed by the legacy updater', () => {
    const legacyEntries = new Set([
      '.next',
      'node_modules',
      'public',
      'package.json',
      'next.config.ts',
      'scripts',
      'prisma',
      'prisma.config.ts',
      '.toolplane-version',
    ]);
    const bootFiles = [
      '.next/required-server-files.json',
      'node_modules/.bin/next',
      'node_modules/.bin/prisma',
      'node_modules/.toolplane-runtime/server.cjs',
      'node_modules/.toolplane-runtime/migrator/node_modules/.bin/prisma',
      'node_modules/.toolplane-runtime/packages/connector/bin/runtime.mjs',
      'node_modules/.toolplane-runtime/messages/en.json',
      'prisma/schema.prisma',
    ];

    expect(bootFiles.every((file) => legacyEntries.has(file.split('/')[0]))).toBe(true);

    const requestConfig = readRepoFile('src/i18n/request.ts');
    expect(requestConfig).not.toContain('import(`../../messages/');
    expect(requestConfig).toContain('messages: MESSAGES[locale]');
  });
});
