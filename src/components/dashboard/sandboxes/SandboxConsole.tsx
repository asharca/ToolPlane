'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Terminal as XtermTerminal } from '@xterm/xterm';
import type { FitAddon as XtermFitAddon } from '@xterm/addon-fit';
import { ChevronRight, FileText, Folder, Loader2, RefreshCw, TerminalIcon } from 'lucide-react';
import { parseSandboxDirectoryText, type SandboxFileEntry } from '@/lib/sandboxes/file-list';

type RpcResult = {
  content?: { type: string; text: string }[];
  isError?: boolean;
};

type TerminalSession = {
  id: string;
};

function textFromResult(result: RpcResult | null): string {
  return result?.content?.[0]?.text ?? JSON.stringify(result, null, 2);
}

function sortedEntries(entries: SandboxFileEntry[]): SandboxFileEntry[] {
  return [...entries].sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1,
  );
}

function joinPath(base: string, name: string): string {
  const cleanBase = base === '.' ? '' : base.replace(/\/+$/, '');
  return cleanBase ? `${cleanBase}/${name}` : name;
}

function parentPath(path: string): string {
  const clean = path.replace(/\/+$/, '');
  if (!clean || clean === '.') return '.';
  const parts = clean.split('/').filter(Boolean);
  parts.pop();
  return parts.length ? parts.join('/') : '.';
}

function normalizePath(path: string): string {
  const clean = path.replace(/\\/g, '/').replace(/^\/workspace\/?/, '').replace(/^\/+/, '').trim();
  return clean || '.';
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function absoluteWorkspacePath(path: string): string {
  const clean = normalizePath(path);
  return clean === '.' ? '/workspace' : `/workspace/${clean}`;
}

function formatSize(size: number | null): string {
  if (size == null) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} KB`;
  return `${Math.round(size / 1024 / 102.4) / 10} MB`;
}

async function callTool(deploymentId: string, name: string, args: Record<string, unknown>): Promise<string> {
  const res = await fetch(`/api/v1/mcp/${deploymentId}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message ?? 'Tool call failed.');
  const result = json.result as RpcResult | null;
  const text = textFromResult(result);
  if (result?.isError) throw new Error(text);
  return text;
}

async function postTerminal(deploymentId: string, sessionId: string, action: 'input' | 'resize', body: unknown) {
  await fetch(`/api/v1/mcp/${deploymentId}/terminal/${sessionId}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: action === 'input',
  });
}

export function SandboxConsole({
  deploymentId,
  running,
  initialPath,
  initialEntries,
}: {
  deploymentId: string;
  running: boolean;
  initialPath: string;
  initialEntries: SandboxFileEntry[];
}) {
  const terminalElementRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XtermTerminal | null>(null);
  const fitRef = useRef<XtermFitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const inputQueueRef = useRef('');
  const inputTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [dirPath, setDirPath] = useState(normalizePath(initialPath));
  const [entries, setEntries] = useState(() => sortedEntries(initialEntries));
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState('');
  const [terminalStatus, setTerminalStatus] = useState(running ? 'Connecting' : 'Stopped');
  const [fileStatus, setFileStatus] = useState(
    initialEntries.length ? `${initialEntries.length} item(s)` : running ? 'Empty directory' : 'Start sandbox to browse files',
  );

  const loadDirectory = useCallback(
    async (nextPath: string) => {
      const normalized = normalizePath(nextPath);
      const raw = await callTool(deploymentId, 'list_dir', { path: normalized });
      const parsed = parseSandboxDirectoryText(raw, normalized);
      if (!parsed) throw new Error(raw);
      return {
        path: normalizePath(parsed.path || normalized),
        entries: sortedEntries(parsed.entries),
      };
    },
    [deploymentId],
  );

  const refreshDir = useCallback(
    async (nextPath = dirPath) => {
      const normalized = normalizePath(nextPath);
      setLoadingPath(normalized);
      try {
        const listing = await loadDirectory(normalized);
        setDirPath(listing.path);
        setEntries(listing.entries);
        setFileStatus(`${listing.entries.length} item(s)`);
        return listing.path;
      } catch (error) {
        setFileStatus(String(error instanceof Error ? error.message : error));
        return null;
      } finally {
        setLoadingPath(null);
      }
    },
    [dirPath, loadDirectory],
  );

  const flushInput = useCallback(() => {
    const sessionId = sessionIdRef.current;
    const data = inputQueueRef.current;
    if (!sessionId || !data) return;
    inputQueueRef.current = '';
    void postTerminal(deploymentId, sessionId, 'input', { data });
  }, [deploymentId]);

  const queueInput = useCallback(
    (data: string) => {
      inputQueueRef.current += data;
      if (inputTimerRef.current) return;
      inputTimerRef.current = setTimeout(() => {
        inputTimerRef.current = null;
        flushInput();
      }, 12);
    },
    [flushInput],
  );

  const resizeTerminal = useCallback(() => {
    const term = terminalRef.current;
    const fit = fitRef.current;
    const sessionId = sessionIdRef.current;
    if (!term || !fit) return;
    fit.fit();
    if (sessionId) void postTerminal(deploymentId, sessionId, 'resize', { cols: term.cols, rows: term.rows });
  }, [deploymentId]);

  useEffect(() => {
    let disposed = false;
    let eventSource: EventSource | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let terminal: XtermTerminal | null = null;

    async function mountTerminal() {
      const element = terminalElementRef.current;
      if (!element) return;
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      if (disposed) return;

      const fit = new FitAddon();
      terminal = new Terminal({
        cursorBlink: true,
        fontFamily: 'var(--font-geist-mono), ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        fontSize: 13,
        lineHeight: 1.45,
        scrollback: 4000,
        theme: {
          background: '#111419',
          foreground: '#e5e7eb',
          cursor: '#f9fafb',
          selectionBackground: '#314158',
        },
      });
      terminal.loadAddon(fit);
      terminal.open(element);
      terminalRef.current = terminal;
      fitRef.current = fit;
      fit.fit();

      if (!running) {
        terminal.writeln('\x1b[33mSandbox is stopped. Start it before opening a terminal.\x1b[0m');
        setTerminalStatus('Stopped');
        return;
      }

      const sessionRes = await fetch(`/api/v1/mcp/${deploymentId}/terminal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cols: terminal.cols, rows: terminal.rows }),
      });
      if (!sessionRes.ok) {
        terminal.writeln(`\x1b[31mFailed to open terminal: ${sessionRes.status}\x1b[0m`);
        setTerminalStatus('Error');
        return;
      }
      const session = (await sessionRes.json()) as TerminalSession;
      sessionIdRef.current = session.id;
      setTerminalStatus('Connected');

      eventSource = new EventSource(`/api/v1/mcp/${deploymentId}/terminal/${session.id}/stream`);
      eventSource.addEventListener('data', (event) => {
        if (disposed || !terminal) return;
        const payload = JSON.parse((event as MessageEvent).data) as { data?: string };
        terminal.write(payload.data ?? '');
      });
      eventSource.addEventListener('exit', (event) => {
        const payload = JSON.parse((event as MessageEvent).data) as { exitCode?: number };
        terminal?.writeln(`\r\n\x1b[33mTerminal exited${payload.exitCode == null ? '' : ` (${payload.exitCode})`}.\x1b[0m`);
        setTerminalStatus('Exited');
      });
      eventSource.onerror = () => {
        if (!disposed) setTerminalStatus('Disconnected');
      };

      terminal.onData((data) => queueInput(data));
      terminal.onResize(({ cols, rows }) => {
        const sessionId = sessionIdRef.current;
        if (sessionId) void postTerminal(deploymentId, sessionId, 'resize', { cols, rows });
      });

      resizeObserver = new ResizeObserver(() => resizeTerminal());
      resizeObserver.observe(element);
      terminal.focus();
    }

    void mountTerminal();

    return () => {
      disposed = true;
      if (inputTimerRef.current) {
        clearTimeout(inputTimerRef.current);
        inputTimerRef.current = null;
      }
      flushInput();
      eventSource?.close();
      resizeObserver?.disconnect();
      const sessionId = sessionIdRef.current;
      if (sessionId) {
        void fetch(`/api/v1/mcp/${deploymentId}/terminal/${sessionId}`, { method: 'DELETE', keepalive: true });
      }
      sessionIdRef.current = null;
      fitRef.current = null;
      terminalRef.current = null;
      terminal?.dispose();
    };
  }, [deploymentId, flushInput, queueInput, resizeTerminal, running]);

  function openFile(path: string) {
    setSelectedPath(path);
    queueInput(`sed -n '1,160p' ${shellEscape(absoluteWorkspacePath(path))}\r`);
  }

  return (
    <div className="grid min-h-[calc(100vh-13rem)] gap-4 xl:grid-cols-[18rem_minmax(0,1fr)]">
      <aside className="ui-panel flex min-h-96 flex-col overflow-hidden">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Folder className="size-4 text-muted-foreground" />
            Files
          </div>
          <button
            type="button"
            onClick={() => void refreshDir(dirPath)}
            disabled={!running || loadingPath !== null}
            className="ui-button-ghost ui-button-sm"
            title="Refresh directory"
          >
            {loadingPath ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          </button>
        </div>

        <div className="border-b border-border p-3">
          <div className="mb-2 truncate font-mono text-xs text-foreground">{absoluteWorkspacePath(dirPath)}</div>
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="truncate">{fileStatus}</span>
            <button
              type="button"
              onClick={() => void refreshDir(parentPath(dirPath))}
              disabled={!running || loadingPath !== null || dirPath === '.'}
              className="rounded px-1.5 py-1 hover:bg-muted hover:text-foreground disabled:opacity-40"
            >
              Up
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-2">
          {entries.length === 0 ? (
            <p className="px-2 py-6 text-sm text-muted-foreground">
              {running ? 'No files in this directory.' : 'Start the sandbox to browse files.'}
            </p>
          ) : (
            entries.map((entry) => {
              const fullPath = joinPath(dirPath, entry.name);
              const selected = selectedPath === fullPath;
              const loading = loadingPath === fullPath;
              return (
                <button
                  key={`${entry.type}:${entry.name}`}
                  type="button"
                  onClick={() => (entry.type === 'dir' ? void refreshDir(fullPath) : openFile(fullPath))}
                  disabled={!running || loadingPath !== null}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-xs transition-colors disabled:opacity-50 ${
                    selected ? 'bg-brand-soft text-accent-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  }`}
                >
                  {loading ? (
                    <Loader2 className="size-3.5 shrink-0 animate-spin" />
                  ) : entry.type === 'dir' ? (
                    <Folder className="size-3.5 shrink-0" />
                  ) : (
                    <FileText className="size-3.5 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  {entry.type === 'dir' ? <ChevronRight className="size-3 shrink-0 opacity-50" /> : null}
                  {entry.type === 'file' ? <span className="shrink-0 text-[10px] opacity-70">{formatSize(entry.size)}</span> : null}
                </button>
              );
            })
          )}
        </div>
      </aside>

      <section className="ui-panel flex min-h-[34rem] min-w-0 flex-col overflow-hidden bg-[#111419]">
        <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
            <TerminalIcon className="size-4 text-zinc-400" />
            Terminal
          </div>
          <div className="flex min-w-0 items-center gap-2 text-xs text-zinc-400">
            <span>{terminalStatus}</span>
            <span className="hidden font-mono sm:inline">{deploymentId}</span>
          </div>
        </div>
        <div ref={terminalElementRef} className="sandbox-terminal min-h-0 flex-1 overflow-hidden" />
      </section>
    </div>
  );
}
