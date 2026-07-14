#!/usr/bin/env node

import { access, chmod, cp, lstat, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.resolve(
  root,
  process.env.TOOLPLANE_RUNTIME_OUTPUT || 'dist/release/app',
);
const standaloneRoot = path.join(root, '.next', 'standalone');
const migratorSource = path.join(root, 'runtime', 'migrator');
const maxRuntimeMiB = Number(process.env.TOOLPLANE_RUNTIME_MAX_MIB || 400);

async function assertPath(target, description) {
  try {
    await access(target);
  } catch {
    throw new Error(`${description} is missing: ${path.relative(root, target)}`);
  }
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function copyEntry(entry) {
  const source = path.join(root, entry);
  await assertPath(source, `Runtime source ${entry}`);
  await cp(source, path.join(outputRoot, entry), {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
}

function run(command, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...extraEnv },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}`));
    });
  });
}

async function directorySize(target) {
  const entries = await readdir(target, { withFileTypes: true });
  let bytes = 0;
  for (const entry of entries) {
    const entryPath = path.join(target, entry.name);
    if (entry.isDirectory()) bytes += await directorySize(entryPath);
    else if (entry.isFile()) bytes += (await lstat(entryPath)).size;
  }
  return bytes;
}

async function pruneNodePtyPackage(packageRoot, targetPrebuild) {
  if (!(await pathExists(packageRoot))) return;

  const prebuildsRoot = path.join(packageRoot, 'prebuilds');
  if (await pathExists(prebuildsRoot)) {
    for (const entry of await readdir(prebuildsRoot, { withFileTypes: true })) {
      if (entry.name !== targetPrebuild) {
        await rm(path.join(prebuildsRoot, entry.name), { recursive: true, force: true });
      }
    }
  }

  for (const entry of ['binding.gyp', 'README.md', 'scripts', 'src', 'third_party', 'typings']) {
    await rm(path.join(packageRoot, entry), { recursive: true, force: true });
  }
}

async function pruneNodePty(output) {
  const platform = process.env.TOOLPLANE_RUNTIME_PLATFORM || `${process.platform}-${process.arch}`;
  const supported = new Set(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']);
  if (!supported.has(platform)) return;

  const nodeModules = path.join(output, 'node_modules');
  const packageRoots = [path.join(nodeModules, 'node-pty')];
  const virtualStore = path.join(nodeModules, '.pnpm');
  if (await pathExists(virtualStore)) {
    for (const entry of await readdir(virtualStore, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('node-pty@')) {
        packageRoots.push(path.join(virtualStore, entry.name, 'node_modules', 'node-pty'));
      }
    }
  }

  await Promise.all(packageRoots.map((packageRoot) => pruneNodePtyPackage(packageRoot, platform)));
}

async function writeLegacyEntrypointShims(output) {
  const binRoot = path.join(output, 'node_modules', '.bin');
  const embeddedRuntimeRoot = path.join(output, 'node_modules', '.toolplane-runtime');
  const serverLauncher = [
    "'use strict';",
    '',
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    '',
    "const appRoot = path.resolve(__dirname, '../..');",
    "process.env.NODE_ENV = 'production';",
    'process.chdir(appRoot);',
    '',
    "const requiredFiles = JSON.parse(fs.readFileSync(path.join(appRoot, '.next', 'required-server-files.json'), 'utf8'));",
    'const nextConfig = requiredFiles.config;',
    'process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig);',
    '',
    "require('next');",
    "const { startServer } = require('next/dist/server/lib/start-server');",
    "const port = Number.parseInt(process.env.PORT || '', 10) || 3000;",
    "const hostname = process.env.HOSTNAME || '0.0.0.0';",
    "const parsedKeepAliveTimeout = Number.parseInt(process.env.KEEP_ALIVE_TIMEOUT || '', 10);",
    'const keepAliveTimeout = Number.isFinite(parsedKeepAliveTimeout) && parsedKeepAliveTimeout >= 0',
    '  ? parsedKeepAliveTimeout',
    '  : undefined;',
    '',
    'startServer({',
    '  dir: appRoot,',
    '  isDev: false,',
    '  config: nextConfig,',
    '  hostname,',
    '  port,',
    '  allowRetry: false,',
    '  keepAliveTimeout,',
    '}).catch((error) => {',
    '  console.error(error);',
    '  process.exit(1);',
    '});',
    '',
  ].join('\n');
  const shims = {
    prisma: `#!/bin/sh
set -e
APP_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
exec "$APP_ROOT/node_modules/.toolplane-runtime/migrator/node_modules/.bin/prisma" "$@" --config "$APP_ROOT/node_modules/.toolplane-runtime/migrator/prisma.config.mjs"
`,
    next: `#!/bin/sh
set -e
if [ "\${1:-}" = "start" ]; then
  shift
fi
APP_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
rm -rf "$APP_ROOT/packages"
ln -s "node_modules/.toolplane-runtime/packages" "$APP_ROOT/packages"
rm -rf "$APP_ROOT/messages"
ln -s "node_modules/.toolplane-runtime/messages" "$APP_ROOT/messages"
rm -rf "$APP_ROOT/.toolplane-update"/backup-*
exec env HOSTNAME="0.0.0.0" node "$APP_ROOT/node_modules/.toolplane-runtime/server.cjs" "$@"
`,
  };

  await mkdir(embeddedRuntimeRoot, { recursive: true });
  await writeFile(path.join(embeddedRuntimeRoot, 'server.cjs'), serverLauncher, 'utf8');
  await mkdir(binRoot, { recursive: true });
  for (const [name, contents] of Object.entries(shims)) {
    const target = path.join(binRoot, name);
    await rm(target, { force: true });
    await writeFile(target, contents, 'utf8');
    await chmod(target, 0o755);
  }
}

await assertPath(standaloneRoot, 'Next standalone output; run `pnpm build` first');
if (!(await pathExists(path.join(migratorSource, 'node_modules', '.bin', 'prisma')))) {
  await run('pnpm', [
    '--config.auto-install-peers=false',
    '--dir',
    'runtime/migrator',
    'install',
    '--prod',
    '--frozen-lockfile',
  ]);
}
await rm(outputRoot, { recursive: true, force: true });
await mkdir(path.dirname(outputRoot), { recursive: true });
await cp(standaloneRoot, outputRoot, {
  recursive: true,
  dereference: false,
  verbatimSymlinks: true,
});

await mkdir(path.join(outputRoot, '.next'), { recursive: true });
await cp(path.join(root, '.next', 'static'), path.join(outputRoot, '.next', 'static'), {
  recursive: true,
});

for (const entry of [
  'public',
  'package.json',
  'next.config.ts',
  'scripts',
  'prisma',
  'prisma.config.ts',
]) {
  await copyEntry(entry);
}

const embeddedRuntimeRoot = path.join(outputRoot, 'node_modules', '.toolplane-runtime');
await mkdir(embeddedRuntimeRoot, { recursive: true });
await cp(migratorSource, path.join(embeddedRuntimeRoot, 'migrator'), {
  recursive: true,
  dereference: false,
  verbatimSymlinks: true,
});
await cp(path.join(root, 'packages'), path.join(embeddedRuntimeRoot, 'packages'), {
  recursive: true,
  dereference: false,
  verbatimSymlinks: true,
});
await cp(path.join(root, 'messages'), path.join(embeddedRuntimeRoot, 'messages'), {
  recursive: true,
  dereference: false,
  verbatimSymlinks: true,
});
for (const entry of ['packages', 'messages']) {
  await rm(path.join(outputRoot, entry), { recursive: true, force: true });
  await symlink(
    path.join('node_modules', '.toolplane-runtime', entry),
    path.join(outputRoot, entry),
    'dir',
  );
}
await writeLegacyEntrypointShims(outputRoot);
await pruneNodePty(outputRoot);

await writeFile(
  path.join(outputRoot, '.toolplane-version'),
  `${process.env.TOOLPLANE_VERSION || 'dev'}\n`,
);

for (const [entry, description] of [
  ['server.js', 'standalone server'],
  ['.next/server', 'standalone server bundle'],
  ['.next/static', 'client static assets'],
  ['messages', 'internationalization messages'],
  ['node_modules/node-pty', 'sandbox PTY runtime'],
  ['node_modules/ws', 'connector WebSocket runtime'],
  ['node_modules/.bin/prisma', 'legacy entrypoint Prisma shim'],
  ['node_modules/.bin/next', 'legacy entrypoint Next shim'],
  ['node_modules/.toolplane-runtime/server.cjs', 'embedded standalone launcher'],
  ['node_modules/.toolplane-runtime/migrator/node_modules/.bin/prisma', 'Prisma migration CLI'],
  ['node_modules/.toolplane-runtime/migrator/prisma.config.mjs', 'runtime Prisma configuration'],
  ['node_modules/.toolplane-runtime/packages/connector/bin/runtime.mjs', 'embedded connector runtime'],
  ['node_modules/.toolplane-runtime/messages/en.json', 'embedded English messages'],
  ['node_modules/.toolplane-runtime/messages/zh.json', 'embedded Chinese messages'],
  ['scripts/mcp-server.mjs', 'built-in MCP runtime'],
  ['scripts/sandbox-mcp-server.mjs', 'sandbox MCP runtime'],
  ['packages/connector/bin/runtime.mjs', 'connector package runtime'],
  ['prisma/schema.prisma', 'Prisma schema'],
]) {
  await assertPath(path.join(outputRoot, entry), description);
}

const runtimeBytes = await directorySize(outputRoot);
const runtimeMiB = runtimeBytes / 1024 / 1024;
if (!Number.isFinite(maxRuntimeMiB) || maxRuntimeMiB <= 0) {
  throw new Error(`Invalid TOOLPLANE_RUNTIME_MAX_MIB: ${process.env.TOOLPLANE_RUNTIME_MAX_MIB}`);
}
if (runtimeMiB > maxRuntimeMiB) {
  throw new Error(
    `Runtime is ${runtimeMiB.toFixed(1)} MiB, above the ${maxRuntimeMiB.toFixed(1)} MiB budget`,
  );
}

console.log(`Assembled runtime at ${path.relative(root, outputRoot)} (${runtimeMiB.toFixed(1)} MiB)`);
