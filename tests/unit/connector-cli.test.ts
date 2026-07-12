import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { describe, expect, it } from 'vitest';
import {
  connectorShell,
  createRuntime,
  expandHome,
  normalizeSandboxPath,
  parseArgs,
  pathIsInside,
  PROTOCOL_VERSION,
  resolveConnectorRoot,
  shellExecArgs,
  terminalShellArgs,
  VERSION,
} from '../../packages/connector/bin/runtime.mjs';
import { buildConnectorPackageTarball, CONNECTOR_TARBALL_FILENAME } from '@/lib/sandboxes/connector-package';
import {
  CONNECTOR_PACKAGE_VERSION,
  CONNECTOR_PROTOCOL_VERSION,
} from '@/lib/sandboxes/connector';
import connectorPackage from '../../packages/connector/package.json';

const installSmoke = process.env.CONNECTOR_INSTALL_SMOKE === '1' ? it : it.skip;

describe('connector CLI portability', () => {
  it('keeps the CLI, package, and hosted tarball versions aligned', () => {
    expect(VERSION).toBe(connectorPackage.version);
    expect(CONNECTOR_PACKAGE_VERSION).toBe(connectorPackage.version);
    expect(CONNECTOR_TARBALL_FILENAME).toContain(connectorPackage.version);
    expect(PROTOCOL_VERSION).toBe(CONNECTOR_PROTOCOL_VERSION);
  });

  it('runs through the symlink shape used by npm and npx bins', () => {
    const cli = path.join(process.cwd(), 'packages', 'connector', 'bin', 'connector.mjs');
    const temp = mkdtempSync(path.join(os.tmpdir(), 'toolplane-connector-bin-'));
    const entry = process.platform === 'win32' ? cli : path.join(temp, 'connector');
    try {
      if (process.platform !== 'win32') symlinkSync(cli, entry);
      const result = spawnSync(process.execPath, [entry, '--help'], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('toolplane connector 0.1.9');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  installSmoke('installs the hosted tarball command through each native shell', async () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'toolplane-connector-install-'));
    const tarballPath = path.join(temp, CONNECTOR_TARBALL_FILENAME);
    try {
      writeFileSync(tarballPath, await buildConnectorPackageTarball(process.cwd()));
      const command = `npx -y --package "${tarballPath}" connector --help`;
      const shells = process.platform === 'win32'
        ? (() => {
            const powershellScript = path.join(temp, 'install.ps1');
            const commandScript = path.join(temp, 'install.cmd');
            writeFileSync(powershellScript, `${command}\r\n`);
            writeFileSync(commandScript, `@echo off\r\n${command}\r\n`);
            return [
              {
                name: 'PowerShell',
                executable: 'powershell.exe',
                args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', powershellScript],
              },
              {
                name: 'Command Prompt',
                executable: process.env.ComSpec || 'cmd.exe',
                args: ['/d', '/s', '/c', commandScript],
              },
            ];
          })()
        : [{
            name: process.platform === 'darwin' ? 'zsh' : 'POSIX shell',
            executable: process.platform === 'darwin' ? '/bin/zsh' : process.env.SHELL || '/bin/sh',
            args: ['-lc', command],
          }];

      for (const shell of shells) {
        const result = spawnSync(shell.executable, shell.args, { encoding: 'utf8', timeout: 120_000 });
        expect(result.status, `${shell.name}: ${result.stderr}`).toBe(0);
        expect(result.stdout).toContain('toolplane connector 0.1.9');
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }, 300_000);

  it('completes bootstrap and a WebSocket request with Bearer auth and no token URLs', async () => {
    const cli = path.join(process.cwd(), 'packages', 'connector', 'bin', 'connector.mjs');
    const root = mkdtempSync(path.join(os.tmpdir(), 'ToolPlane handshake 测试 '));
    const token = 'mcpcon_cross_platform_handshake';
    const wss = new WebSocketServer({ noServer: true });
    let wsUrl = '';
    let bootstrapAuthorization = '';
    let bootstrapSearch = '';
    let upgradeAuthorization = '';
    let upgradeSearch = '';

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      bootstrapAuthorization = String(req.headers.authorization ?? '');
      bootstrapSearch = url.search;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        sandboxId: 'sb-handshake',
        name: 'Cross-platform handshake',
        root,
        wsUrl,
      }));
    });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      upgradeAuthorization = String(req.headers.authorization ?? '');
      upgradeSearch = url.search;
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    const serverUrl = `http://127.0.0.1:${port}`;
    wsUrl = `ws://127.0.0.1:${port}/connect`;

    let child: ReturnType<typeof spawn> | null = null;
    let output = '';
    try {
      const exchange = new Promise<{ hello: Record<string, unknown>; ping: Record<string, unknown> }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`connector handshake timed out\n${output}`)), 15_000);
        wss.once('connection', (ws) => {
          let hello: Record<string, unknown> | null = null;
          ws.on('message', (raw) => {
            const message = JSON.parse(raw.toString()) as Record<string, unknown>;
            if (message.type === 'hello') {
              hello = message;
              ws.send(JSON.stringify({ type: 'request', id: 'ping-1', op: 'ping', args: {} }));
              return;
            }
            if (message.type === 'response' && message.id === 'ping-1' && hello) {
              clearTimeout(timer);
              resolve({ hello, ping: message.result as Record<string, unknown> });
            }
          });
        });
      });

      child = spawn(process.execPath, [
        cli,
        'connect',
        '--server',
        serverUrl,
        '--token',
        token,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout?.on('data', (chunk) => { output += chunk.toString(); });
      child.stderr?.on('data', (chunk) => { output += chunk.toString(); });

      const result = await exchange;
      expect(bootstrapAuthorization).toBe(`Bearer ${token}`);
      expect(upgradeAuthorization).toBe(`Bearer ${token}`);
      expect(bootstrapSearch).toBe('');
      expect(upgradeSearch).toBe('');
      expect(result.hello).toMatchObject({
        protocolVersion: PROTOCOL_VERSION,
        root: path.resolve(root),
        platform: process.platform,
        capabilities: ['process_exec', 'write_file_base64'],
      });
      expect(result.ping).toMatchObject({ ok: true, root: path.resolve(root) });
    } finally {
      child?.kill('SIGTERM');
      if (child?.exitCode === null) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2000);
          child?.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  }, 25_000);

  it('runs shell and terminal operations through the connector runtime', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ToolPlane terminal '));
    const runtime = createRuntime(root);
    const events: Array<Record<string, unknown>> = [];
    const ws = {
      readyState: 1,
      send: (raw: string) => events.push(JSON.parse(raw) as Record<string, unknown>),
    };
    try {
      const windows = process.platform === 'win32';
      const shellCommand = windows
        ? 'Write-Output "$env:TOOLPLANE_TEST runtime-shell-ok"'
        : 'printf "%s runtime-shell-ok\\n" "$TOOLPLANE_TEST"';
      const shellResult = await runtime.handle(ws, 'shell_exec', {
        command: shellCommand,
        cwd: '.',
        env: { TOOLPLANE_TEST: 'cross-platform' },
      });
      expect(shellResult).toMatchObject({ exitCode: 0, timedOut: false });
      expect(shellResult.stdout).toContain('cross-platform runtime-shell-ok');

      const { terminalId } = await runtime.handle(ws, 'terminal_create', {
        cols: 80,
        rows: 24,
        env: { TOOLPLANE_TEST: 'cross-platform' },
      });
      await runtime.handle(ws, 'terminal_resize', { terminalId, cols: 100, rows: 30 });
      const terminalCommand = windows
        ? 'Write-Output "$env:TOOLPLANE_TEST runtime-terminal-ok"\r\nexit\r\n'
        : 'printf "%s runtime-terminal-ok\\n" "$TOOLPLANE_TEST"\nexit\n';
      await runtime.handle(ws, 'terminal_input', { terminalId, data: terminalCommand });

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`terminal runtime timed out: ${JSON.stringify(events)}`)), 10_000);
        const check = () => {
          if (events.some((event) => event.type === 'terminal_exit' && event.terminalId === terminalId)) {
            clearTimeout(timer);
            resolve();
          } else {
            setTimeout(check, 20);
          }
        };
        check();
      });
      const terminalOutput = events
        .filter((event) => event.type === 'terminal_data' && event.terminalId === terminalId)
        .map((event) => String(event.data ?? ''))
        .join('');
      expect(terminalOutput).toContain('cross-platform runtime-terminal-ok');
      await runtime.handle(ws, 'terminal_close', { terminalId });
    } finally {
      runtime.closeAllTerminals();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('executes structured processes and binary file operations in a spaced Unicode root', async () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'ToolPlane Ada 测试 '));
    const outside = mkdtempSync(path.join(os.tmpdir(), 'toolplane-outside-'));
    const runtime = createRuntime(temp);
    const ws = { readyState: 1, send: () => undefined };
    try {
      const ping = await runtime.handle(ws, 'ping', {});
      expect(ping).toMatchObject({
        ok: true,
        platform: process.platform,
        arch: process.arch,
        root: path.resolve(temp),
      });

      const bytes = Buffer.from([0, 1, 2, 127, 128, 255]);
      await runtime.handle(ws, 'write_file_base64', {
        path: 'assets/binary file.bin',
        content: bytes.toString('base64'),
      });
      const download = await runtime.handle(ws, 'download_file', { path: 'assets/binary file.bin' });
      expect(download.content).toBe(bytes.toString('base64'));

      writeFileSync(path.join(outside, 'secret.txt'), 'outside');
      symlinkSync(outside, path.join(temp, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
      await expect(runtime.handle(ws, 'read_file', { path: 'escape/secret.txt' })).rejects.toThrow(/link/i);
      await expect(runtime.handle(ws, 'write_file', { path: 'escape/new.txt', content: 'nope' })).rejects.toThrow(/link/i);

      const result = await runtime.handle(ws, 'process_exec', {
        runtime: 'node',
        args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', 'space value', "quote'value", '$&|'],
        cwd: '.',
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(['space value', "quote'value", '$&|']);

      const timedOut = await runtime.handle(ws, 'process_exec', {
        runtime: 'node',
        args: ['-e', 'setTimeout(() => {}, 10000)'],
        timeoutMs: 50,
      });
      expect(timedOut.timedOut).toBe(true);
    } finally {
      runtime.closeAllTerminals();
      rmSync(temp, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }, 15_000);

  it('leaves root unset so bootstrap owns the configured path', () => {
    expect(parseArgs([
      'connect',
      '--server',
      'https://app.example.com',
      '--token',
      'mcpcon_test',
    ])).toEqual({
      help: false,
      command: 'connect',
      server: 'https://app.example.com',
      token: 'mcpcon_test',
      root: undefined,
    });

    expect(resolveConnectorRoot(undefined, 'C:\\Users\\Ada Lovelace\\ToolPlane Sandbox')).toBe(
      'C:\\Users\\Ada Lovelace\\ToolPlane Sandbox',
    );
  });

  it('keeps an explicit CLI root as an override', () => {
    const args = parseArgs([
      'connect',
      '--server',
      'https://app.example.com',
      '--token',
      'mcpcon_test',
      '--root',
      'D:\\Work Area',
    ]);

    expect(args.root).toBe('D:\\Work Area');
    expect(resolveConnectorRoot(args.root, '~/toolplane-sandbox')).toBe('D:\\Work Area');
  });

  it('expands slash and backslash home aliases with native path rules', () => {
    expect(expandHome('~/ToolPlane', 'C:\\Users\\Ada', path.win32)).toBe('C:\\Users\\Ada\\ToolPlane');
    expect(expandHome('~\\ToolPlane', 'C:\\Users\\Ada', path.win32)).toBe('C:\\Users\\Ada\\ToolPlane');
  });

  it('normalizes virtual workspace paths without rewriting workspace-prefixed names', () => {
    expect(normalizeSandboxPath('/workspace/folder\\file.txt')).toBe('folder/file.txt');
    expect(normalizeSandboxPath('/workspacefoo/file.txt')).toBe('workspacefoo/file.txt');
    expect(() => normalizeSandboxPath('../outside')).toThrow(/escapes connector root/i);
  });

  it('contains Windows drive and UNC paths with case-insensitive semantics', () => {
    expect(pathIsInside('C:\\', 'C:\\Users\\Ada', path.win32)).toBe(true);
    expect(pathIsInside('C:\\Users\\ADA', 'c:\\users\\ada\\work', path.win32)).toBe(true);
    expect(pathIsInside('C:\\Users\\Ada', 'D:\\Work', path.win32)).toBe(false);
    expect(pathIsInside('\\\\server\\share', '\\\\server\\share\\folder', path.win32)).toBe(true);
  });

  it('uses PowerShell semantics on Windows and POSIX semantics elsewhere', () => {
    expect(connectorShell('win32', { NODE_ENV: 'test' })).toBe('powershell.exe');
    expect(connectorShell('win32', { NODE_ENV: 'test', TOOLPLANE_CONNECTOR_SHELL: 'cmd.exe' })).toBe('powershell.exe');
    expect(connectorShell('win32', { NODE_ENV: 'test', TOOLPLANE_CONNECTOR_SHELL: 'C:\\Tools\\pwsh.exe' })).toBe(
      'C:\\Tools\\pwsh.exe',
    );
    expect(shellExecArgs('Get-ChildItem', 'win32')).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      'Get-ChildItem',
    ]);
    expect(terminalShellArgs('win32')).toEqual(['-NoLogo']);
    expect(shellExecArgs('ls', 'linux')).toEqual(['-lc', 'ls']);
    expect(terminalShellArgs('darwin')).toEqual([]);
  });

  it('rejects missing values and unknown flags', () => {
    expect(() => parseArgs(['connect', '--server', 'https://app.example.com'])).toThrow(/required/i);
    expect(() => parseArgs([
      'connect',
      '--server',
      'https://app.example.com',
      '--token',
      'mcpcon_test',
      '--shell',
      'cmd',
    ])).toThrow(/unknown connector option/i);
  });
});
