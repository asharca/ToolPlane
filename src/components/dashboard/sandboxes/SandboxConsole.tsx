'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Terminal as XtermTerminal } from '@xterm/xterm';
import type { FitAddon as XtermFitAddon } from '@xterm/addon-fit';
import { ChevronRight, Download, FileText, Folder, Loader2, RefreshCw, TerminalIcon, Trash2, X } from 'lucide-react';
import { parseSandboxDirectoryText, type SandboxFileEntry } from '@/lib/sandboxes/file-list';

type RpcResult = {
  content?: { type: string; text: string }[];
  isError?: boolean;
};

type TerminalSession = {
  id: string;
};

type DownloadPayload = {
  filename?: string;
  content?: string;
  encoding?: string;
};

type FilePreview = {
  path: string;
  content: string;
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

function displayWorkspacePath(path: string, workspaceRoot = '/workspace'): string {
  const clean = normalizePath(path);
  const separator = workspaceRoot.includes('\\') && !workspaceRoot.includes('/') ? '\\' : '/';
  const trimmedRoot = workspaceRoot.replace(/[\\/]+$/, '') || separator;
  const root = /^[A-Za-z]:$/.test(trimmedRoot) ? `${trimmedRoot}${separator}` : trimmedRoot;
  const joiner = root.endsWith(separator) ? '' : separator;
  return clean === '.' ? root : `${root}${joiner}${clean.replaceAll('/', separator)}`;
}

function formatSize(size: number | null): string {
  if (size == null) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} KB`;
  return `${Math.round(size / 1024 / 102.4) / 10} MB`;
}

function downloadBase64File(payload: DownloadPayload, fallbackName: string) {
  if (payload.encoding !== 'base64' || typeof payload.content !== 'string') {
    throw new Error('Download response was not base64.');
  }
  const binary = atob(payload.content);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes]));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = payload.filename || fallbackName;
  anchor.click();
  URL.revokeObjectURL(url);
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

async function postTerminal(terminalApiBase: string, sessionId: string, action: 'input' | 'resize', body: unknown) {
  await fetch(`${terminalApiBase}/${sessionId}/${action}`, {
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
  terminalOnly = false,
  terminalApiBase,
  terminalLabel,
  terminalSubtitle,
  workspaceRoot,
  waitingForConnector = false,
}: {
  deploymentId: string;
  running: boolean;
  initialPath: string;
  initialEntries: SandboxFileEntry[];
  terminalOnly?: boolean;
  terminalApiBase?: string;
  terminalLabel?: string;
  terminalSubtitle?: string;
  workspaceRoot?: string;
  waitingForConnector?: boolean;
}) {
  const t = useTranslations('console.sandboxes');
  const terminalBase = terminalApiBase ?? `/api/v1/mcp/${deploymentId}/terminal`;
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
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [terminalStatus, setTerminalStatus] = useState(
    running ? 'Connecting' : waitingForConnector ? t('waitingForConnector') : 'Stopped',
  );
  const [terminalGeneration, setTerminalGeneration] = useState(0);
  const [fileStatus, setFileStatus] = useState(
    initialEntries.length
      ? `${initialEntries.length} item(s)`
      : running
        ? 'Empty directory'
        : waitingForConnector
          ? t('waitingForConnector')
          : 'Start sandbox to browse files',
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
        setPreview(null);
        setSelectedPath('');
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
    void postTerminal(terminalBase, sessionId, 'input', { data });
  }, [terminalBase]);

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
    if (sessionId) void postTerminal(terminalBase, sessionId, 'resize', { cols: term.cols, rows: term.rows });
  }, [terminalBase]);

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
        terminal.writeln(`\x1b[33m${waitingForConnector
          ? t('waitingForConnectorSession')
          : t('sandboxStoppedTerminalHint')}\x1b[0m`);
        setTerminalStatus(waitingForConnector ? t('waitingForConnector') : 'Stopped');
        return;
      }

      const sessionRes = await fetch(terminalBase, {
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

      eventSource = new EventSource(`${terminalBase}/${session.id}/stream`);
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
        if (sessionId) void postTerminal(terminalBase, sessionId, 'resize', { cols, rows });
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
        void fetch(`${terminalBase}/${sessionId}`, { method: 'DELETE', keepalive: true });
      }
      sessionIdRef.current = null;
      fitRef.current = null;
      terminalRef.current = null;
      terminal?.dispose();
    };
  }, [flushInput, queueInput, resizeTerminal, running, t, terminalBase, terminalGeneration, waitingForConnector]);

  async function openFile(path: string) {
    setSelectedPath(path);
    setLoadingPath(path);
    try {
      const raw = await callTool(deploymentId, 'read_file', { path });
      const payload = JSON.parse(raw) as Partial<FilePreview>;
      if (typeof payload.content !== 'string') throw new Error(t('filePreviewUnavailable'));
      setPreview({ path, content: payload.content });
      setFileStatus(path);
    } catch (error) {
      setFileStatus(String(error instanceof Error ? error.message : error));
    } finally {
      setLoadingPath(null);
    }
  }

  async function downloadFile(path: string) {
    setLoadingPath(path);
    try {
      const raw = await callTool(deploymentId, 'download_file', { path });
      downloadBase64File(JSON.parse(raw) as DownloadPayload, path.split('/').pop() || 'sandbox-file');
      setFileStatus(t('downloadFile'));
    } catch (error) {
      setFileStatus(String(error instanceof Error ? error.message : error));
    } finally {
      setLoadingPath(null);
    }
  }

  async function deleteFile(path: string) {
    if (!window.confirm(t('deleteThisFile'))) return;
    setLoadingPath(path);
    try {
      await callTool(deploymentId, 'delete_file', { path });
      if (selectedPath === path) {
        setSelectedPath('');
        setPreview(null);
      }
      await refreshDir(dirPath);
    } catch (error) {
      setFileStatus(String(error instanceof Error ? error.message : error));
    } finally {
      setLoadingPath(null);
    }
  }

  const terminalPanel = (
    <section
      className={terminalOnly
        ? 'flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[#111419]'
        : 'ui-panel flex min-h-[34rem] min-w-0 flex-col overflow-hidden bg-[#111419]'}
    >
      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
          <TerminalIcon className="size-4 text-zinc-400" />
          {terminalLabel ?? t('terminal')}
        </div>
        <div className="flex min-w-0 items-center gap-2 text-xs text-zinc-400">
          <span>{terminalStatus}</span>
          <span className="hidden max-w-80 truncate font-mono sm:inline">
            {terminalSubtitle ?? deploymentId}
          </span>
          <button
            type="button"
            onClick={() => {
              setTerminalStatus('Connecting');
              setTerminalGeneration((value) => value + 1);
            }}
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
            title={t('reconnectTerminal')}
            aria-label={t('reconnectTerminal')}
          >
            <RefreshCw className="size-3.5" />
          </button>
        </div>
      </div>
      <div ref={terminalElementRef} className="sandbox-terminal min-h-0 flex-1 overflow-hidden" />
    </section>
  );

  if (terminalOnly) return terminalPanel;

  return (
    <div className="grid min-h-[calc(100vh-13rem)] gap-4 xl:grid-cols-[18rem_minmax(0,1fr)]">
      <aside className="ui-panel order-2 flex min-h-96 flex-col overflow-hidden xl:order-1">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Folder className="size-4 text-muted-foreground" />
            {t('files')}
          </div>
          <button
            type="button"
            onClick={() => void refreshDir(dirPath)}
            disabled={!running || loadingPath !== null}
            className="ui-button-ghost ui-button-sm"
            title={t('refreshDirectory')}
          >
            {loadingPath ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          </button>
        </div>

        <div className="border-b border-border p-3">
          <div className="mb-2 truncate font-mono text-xs text-foreground">{displayWorkspacePath(dirPath, workspaceRoot)}</div>
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="truncate">{fileStatus}</span>
            <button
              type="button"
              onClick={() => void refreshDir(parentPath(dirPath))}
              disabled={!running || loadingPath !== null || dirPath === '.'}
              className="rounded px-1.5 py-1 hover:bg-muted hover:text-foreground disabled:opacity-40"
            >
              {t('up')}
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-2">
          {entries.length === 0 ? (
            <p className="px-2 py-6 text-sm text-muted-foreground">
              {running
                ? t('noFilesInThisDirectory')
                : waitingForConnector
                  ? t('waitingForConnectorSession')
                  : t('startTheSandboxToBrowseFiles')}
            </p>
          ) : (
            entries.map((entry) => {
              const fullPath = joinPath(dirPath, entry.name);
              const selected = selectedPath === fullPath;
              const loading = loadingPath === fullPath;
              return (
                <div
                  key={`${entry.type}:${entry.name}`}
                  className={`group flex items-center gap-1 rounded-md transition-colors ${
                    selected ? 'bg-brand-soft text-accent-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => (entry.type === 'dir' ? void refreshDir(fullPath) : void openFile(fullPath))}
                    disabled={!running || loadingPath !== null}
                    className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left font-mono text-xs disabled:opacity-50"
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
                  {entry.type === 'file' ? (
                    <div className="flex shrink-0 items-center pr-1">
                      <button
                        type="button"
                        onClick={() => void downloadFile(fullPath)}
                        disabled={!running || loadingPath !== null}
                        className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-40"
                        title={t('downloadFile')}
                        aria-label={t('downloadFile')}
                      >
                        <Download className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void deleteFile(fullPath)}
                        disabled={!running || loadingPath !== null}
                        className="rounded p-1 text-muted-foreground hover:bg-red-500/10 hover:text-red-600 disabled:opacity-40 dark:hover:text-red-300"
                        title={t('deleteFile')}
                        aria-label={t('deleteFile')}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </aside>

      <div className="relative order-1 min-h-[34rem] min-w-0 xl:order-2">
        {terminalPanel}
        {preview ? (
          <section className="absolute inset-0 flex min-h-0 flex-col overflow-hidden border border-border bg-card">
            <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
              <div className="min-w-0 truncate font-mono text-xs font-medium text-foreground">
                {displayWorkspacePath(preview.path, workspaceRoot)}
              </div>
              <button
                type="button"
                onClick={() => {
                  setPreview(null);
                  setSelectedPath('');
                }}
                className="ui-button-ghost ui-icon-button shrink-0"
                title={t('close')}
                aria-label={t('close')}
              >
                <X className="size-4" />
              </button>
            </div>
            <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-5 text-foreground">
              {preview.content}
            </pre>
          </section>
        ) : null}
      </div>
    </div>
  );
}
