import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { WebSocketServer, type WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import {
  connectorShell,
  createRuntime,
  expandHome,
  normalizeSandboxPath,
  parseArgs,
  parseVncEndpoint,
  pathIsInside,
  probeVncEndpoint,
  PROTOCOL_VERSION,
  resolveConnectorRoot,
  shellExecArgs,
  terminalShellArgs,
  VERSION,
} from '../../packages/connector/bin/runtime.mjs';
import {
  createAndroidRuntime,
  resolveAndroidRoot,
  resolveAndroidSerial,
} from '../../packages/connector/bin/android.mjs';
import { buildConnectorPackageTarball, CONNECTOR_TARBALL_FILENAME } from '@/lib/sandboxes/connector-package';
import {
  CONNECTOR_PACKAGE_VERSION,
  CONNECTOR_PROTOCOL_VERSION,
} from '@/lib/sandboxes/connector';
import connectorPackage from '../../packages/connector/package.json';

const installSmoke = process.env.CONNECTOR_INSTALL_SMOKE === '1' ? it : it.skip;

function writeFakeAdb(directory: string): string {
  const executable = path.join(directory, 'fake-adb');
  writeFileSync(executable, [
    '#!/usr/bin/env node',
    "const args = process.argv.slice(2);",
    "if (args[0] === 'devices') { process.stdout.write('List of devices attached\\ndevice-one\\tdevice\\ndevice-two\\tdevice\\n'); process.exit(0); }",
    "if (args.at(-1) === 'get-state') { process.stdout.write('device\\n'); process.exit(0); }",
    "if (args.includes('screencap')) { process.stdout.write(Buffer.from('iVBORw0KGgo=', 'base64')); process.exit(0); }",
    "const command = args.at(-1) || '';",
    "if (command.includes('getprop ro.product.model')) { process.stdout.write('Pixel Test\\naarch64\\n'); process.exit(0); }",
    "if (command.includes('canonical()') && command.includes('/escape/')) process.exit(42);",
  ].join('\n'), { mode: 0o755 });
  return executable;
}

describe('connector CLI portability', () => {
  it('keeps the CLI, package, and hosted tarball versions aligned', () => {
    expect(VERSION).toBe(connectorPackage.version);
    expect(CONNECTOR_PACKAGE_VERSION).toBe(connectorPackage.version);
    expect(CONNECTOR_TARBALL_FILENAME).toContain(connectorPackage.version);
    expect(PROTOCOL_VERSION).toBe(CONNECTOR_PROTOCOL_VERSION);
  });

  it('ships the Android runtime in the hosted connector tarball', async () => {
    const tar = gunzipSync(await buildConnectorPackageTarball(process.cwd()));
    expect(tar.includes(Buffer.from('package/bin/android.mjs'))).toBe(true);
  });

  it('runs through the symlink shape used by npm and npx bins', () => {
    const cli = path.join(process.cwd(), 'packages', 'connector', 'bin', 'connector.mjs');
    const temp = mkdtempSync(path.join(os.tmpdir(), 'toolplane-connector-bin-'));
    const entry = process.platform === 'win32' ? cli : path.join(temp, 'connector');
    try {
      if (process.platform !== 'win32') symlinkSync(cli, entry);
      const result = spawnSync(process.execPath, [entry, '--help'], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('toolplane connector 0.1.13');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  installSmoke('installs the hosted tarball command through each native shell', async () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'toolplane-connector-install-'));
    const tarballPath = path.join(temp, CONNECTOR_TARBALL_FILENAME);
    try {
      writeFileSync(tarballPath, await buildConnectorPackageTarball(process.cwd()));
      const command = `npx -y --no-audit --package "${tarballPath}" connector --help`;
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
        expect(result.stdout).toContain('toolplane connector 0.1.13');
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

    if (!('root' in args)) throw new Error('Expected parsed connector arguments.');
    expect(args.root).toBe('D:\\Work Area');
    expect(resolveConnectorRoot(args.root, '~/toolplane-sandbox')).toBe('D:\\Work Area');
  });

  it('validates Android and loopback-only VNC CLI targets', () => {
    expect(parseArgs([
      'connect',
      '--server',
      'https://app.example.com',
      '--token',
      'mcpcon_test',
      '--android',
      'emulator-5554',
    ])).toMatchObject({ android: 'emulator-5554' });
    expect(parseVncEndpoint('auto')).toEqual({ host: '127.0.0.1', port: 5900 });
    expect(parseVncEndpoint('127.0.0.1:5901')).toEqual({ host: '127.0.0.1', port: 5901 });
    for (const target of ['localhost:5900', '0.0.0.0:5900', '127.0.0.2:5900', '127.0.0.1:0', '127.0.0.1:65536']) {
      expect(() => parseVncEndpoint(target)).toThrow(/screen-vnc/i);
    }
    expect(() => parseArgs([
      'connect', '--server', 'https://app.example.com', '--token', 'mcpcon_test',
      '--android', 'auto', '--screen-vnc', 'auto',
    ])).toThrow(/cannot be used together/i);
  });

  it('probes only the fixed loopback VNC endpoint before advertising it', async () => {
    const server = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    try {
      await expect(probeVncEndpoint({ host: '127.0.0.1', port }, 1000)).resolves.toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await expect(probeVncEndpoint({ host: '127.0.0.1', port }, 100)).resolves.toBe(false);
  });

  it('forces legacy VNC password auth while keeping Apple Screen Sharing on RFB 3.8', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'toolplane-vnc-'));
    const token = 'mcpcon_vnc_relay';
    const vncServer = net.createServer();
    const relayWss = new WebSocketServer({ noServer: true });
    let vncSocket: Socket | undefined;
    let sourceSocket: WebSocket | undefined;
    let sourceAuthorization = '';
    let resolveSourceData!: (value: Buffer) => void;
    const sourceData = new Promise<Buffer>((resolve) => { resolveSourceData = resolve; });
    relayWss.on('connection', (ws) => {
      sourceSocket = ws;
      ws.once('message', (raw) => resolveSourceData(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer)));
    });
    const relayServer = http.createServer();
    relayServer.on('upgrade', (req, socket, head) => {
      sourceAuthorization = String(req.headers.authorization ?? '');
      relayWss.handleUpgrade(req, socket, head, (ws) => relayWss.emit('connection', ws, req));
    });
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        vncServer.once('error', reject);
        vncServer.listen(0, '127.0.0.1', resolve);
      }),
      new Promise<void>((resolve, reject) => {
        relayServer.once('error', reject);
        relayServer.listen(0, '127.0.0.1', resolve);
      }),
    ]);
    const vncPort = (vncServer.address() as AddressInfo).port;
    const relayPort = (relayServer.address() as AddressInfo).port;
    const connected = new Promise<Socket>((resolve) => {
      vncServer.once('connection', (socket) => {
        vncSocket = socket;
        socket.write('RFB');
        resolve(socket);
      });
    });
    const runtime = createRuntime(root, {
      screenVnc: { host: '127.0.0.1', port: vncPort },
      token,
      wsUrl: `ws://127.0.0.1:${relayPort}/connect`,
    });

    try {
      expect(runtime.info).toMatchObject({
        displays: [{ id: 'vnc', label: 'Screen', transport: 'rfb', control: true }],
      });
      await expect(runtime.handle({ readyState: 1, send: () => undefined }, 'screen_open', {
        sessionId: 'screen_session_1',
        sourceUrl: `ws://127.0.0.1:${relayPort}/screen/source/screen_session_1`,
        displayId: 'vnc',
      })).resolves.toMatchObject({ ok: true, sessionId: 'screen_session_1', displayId: 'vnc' });
      const socket = await connected;
      socket.write(' 003.889\n');
      await expect(sourceData).resolves.toEqual(Buffer.from('RFB 003.008\n'));
      expect(sourceAuthorization).toBe(`Bearer ${token}`);
      if (!sourceSocket) throw new Error('Expected screen source connection.');

      const viewerVersion = new Promise<Buffer>((resolve) => socket.once('data', resolve));
      sourceSocket.send(Buffer.from('RFB 003.008\n'));
      await expect(viewerVersion).resolves.toEqual(Buffer.from('RFB 003.008\n'));

      const securityTypes = new Promise<Buffer>((resolve) => {
        sourceSocket?.once('message', (raw) => resolve(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer)));
      });
      socket.write(Buffer.from([7, 30, 33]));
      await new Promise<void>((resolve) => setImmediate(resolve));
      socket.write(Buffer.from([36, 31, 32, 2, 35]));
      await expect(securityTypes).resolves.toEqual(Buffer.from([1, 2]));

      const selectedType = new Promise<Buffer>((resolve) => socket.once('data', resolve));
      sourceSocket.send(Buffer.from([2]));
      await expect(selectedType).resolves.toEqual(Buffer.from([2]));

      const challenge = Buffer.from('0123456789abcdef');
      const relayedChallenge = new Promise<Buffer>((resolve) => {
        sourceSocket?.once('message', (raw) => resolve(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer)));
      });
      socket.write(challenge);
      await expect(relayedChallenge).resolves.toEqual(challenge);

      const response = Buffer.from('fedcba9876543210');
      const relayedResponse = new Promise<Buffer>((resolve) => socket.once('data', resolve));
      sourceSocket.send(response);
      await expect(relayedResponse).resolves.toEqual(response);
    } finally {
      runtime.closeAllTerminals();
      sourceSocket?.terminate();
      vncSocket?.destroy();
      relayWss.close();
      await Promise.all([
        new Promise<void>((resolve) => relayServer.close(() => resolve())),
        new Promise<void>((resolve) => vncServer.close(() => resolve())),
      ]);
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it.skipIf(process.platform === 'win32')('discovers Android devices strictly and exposes bounded screenshots', async () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'toolplane-fake-adb-'));
    const adb = writeFakeAdb(temp);
    try {
      await expect(resolveAndroidSerial('auto', { adb })).rejects.toThrow(/more than one/i);
      expect(resolveAndroidRoot(undefined, '~/toolplane-sandbox')).toBe('/data/local/tmp/toolplane-sandbox');
      expect(() => resolveAndroidRoot('/')).toThrow(/filesystem root/i);

      const runtime = await createAndroidRuntime('/sdcard/ToolPlane', 'device-one', { adb });
      const ws = { readyState: 1, send: () => undefined };
      try {
        expect(runtime.info).toMatchObject({
          platform: 'android',
          root: '/sdcard/ToolPlane',
          device: { kind: 'android', name: 'Pixel Test' },
          capabilities: ['process_exec', 'write_file_base64', 'terminal', 'files', 'screen_capture'],
          displays: [{ id: 'main', label: 'Screen', transport: 'snapshot', control: false }],
        });
        await expect(runtime.handle(ws, 'read_file', { path: '../secret.txt' })).rejects.toThrow(/escapes connector root/i);
        await expect(runtime.handle(ws, 'read_file', { path: 'escape/secret.txt' })).rejects.toThrow(/through a link/i);

        const capture = await runtime.handle(ws, 'screen_capture', { displayId: 'main' });
        expect(capture).toMatchObject({ contentType: 'image/png', size: 8 });
        if (!('data' in capture)) throw new Error('Expected screen capture data.');
        expect(Buffer.from(capture.data, 'base64')).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      } finally {
        runtime.closeAllTerminals();
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
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
