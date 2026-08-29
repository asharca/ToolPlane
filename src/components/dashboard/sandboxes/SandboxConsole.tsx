'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Terminal as XtermTerminal } from '@xterm/xterm';
import type { FitAddon as XtermFitAddon } from '@xterm/addon-fit';
import { ArrowLeft, ChevronRight, Download, FileText, Folder, FolderOpen, Loader2, RefreshCw, TerminalIcon, Trash2, Upload } from 'lucide-react';
import { AssistantMarkdown } from '@/components/dashboard/ConversationMessage';
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
  kind: 'text' | 'markdown' | 'image' | 'pdf' | 'unsupported';
  content?: string;
  url?: string;
};

const IMAGE_MIME_TYPES: Record<string, string> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};
const TEXT_EXTENSIONS = new Set([
  'bash', 'c', 'cc', 'conf', 'cpp', 'css', 'csv', 'env', 'go', 'h', 'hpp', 'html',
  'ini', 'java', 'js', 'json', 'jsonl', 'jsx', 'log', 'mjs', 'py', 'rs', 'scss',
  'sh', 'sql', 'toml', 'ts', 'tsx', 'txt', 'xml', 'yaml', 'yml', 'zsh',
]);

function previewType(path: string): { kind: FilePreview['kind']; mimeType?: string } {
  const filename = path.split('/').pop() ?? '';
  const extension = filename.includes('.') ? filename.split('.').pop()?.toLowerCase() ?? '' : '';
  if (extension === 'md' || extension === 'mdx') return { kind: 'markdown' };
  if (extension === 'pdf') return { kind: 'pdf', mimeType: 'application/pdf' };
  if (IMAGE_MIME_TYPES[extension]) return { kind: 'image', mimeType: IMAGE_MIME_TYPES[extension] };
  if (!extension || TEXT_EXTENSIONS.has(extension)) return { kind: 'text' };
  return { kind: 'unsupported' };
}

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

function decodeBase64File(
  payload: DownloadPayload,
  fallbackName: string,
  invalidMessage: string,
  mimeType = 'application/octet-stream',
) {
  if (payload.encoding !== 'base64' || typeof payload.content !== 'string') {
    throw new Error(invalidMessage);
  }
  const binary = atob(payload.content);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return { blob: new Blob([bytes], { type: mimeType }), filename: payload.filename || fallbackName };
}

function downloadBase64File(payload: DownloadPayload, fallbackName: string, invalidMessage: string) {
  const { blob, filename } = decodeBase64File(payload, fallbackName, invalidMessage);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function callSandboxTool(
  rpcApiBase: string,
  name: string,
  args: Record<string, unknown>,
  fallbackError: string,
): Promise<string> {
  const res = await fetch(rpcApiBase, {
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
  if (json.error) throw new Error(json.error.message ?? fallbackError);
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
  filesOnly = false,
  compact = false,
  terminalApiBase,
  rpcApiBase,
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
  filesOnly?: boolean;
  compact?: boolean;
  terminalApiBase?: string;
  rpcApiBase?: string;
  terminalLabel?: string;
  terminalSubtitle?: string;
  workspaceRoot?: string;
  waitingForConnector?: boolean;
}) {
  const t = useTranslations('console.sandboxes');
  const terminalBase = terminalApiBase ?? `/api/v1/mcp/${deploymentId}/terminal`;
  const rpcBase = rpcApiBase ?? `/api/v1/mcp/${deploymentId}/rpc`;
  const uploadBase = `/api/v1/mcp/${deploymentId}/files/upload`;
  const terminalElementRef = useRef<HTMLDivElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const terminalRef = useRef<XtermTerminal | null>(null);
  const fitRef = useRef<XtermFitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const inputQueueRef = useRef('');
  const inputTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedDirectoryRef = useRef(initialEntries.length
    ? `${rpcBase}:${normalizePath(initialPath)}`
    : '');
  const treeScopeRef = useRef(`${rpcBase}:${normalizePath(initialPath)}`);

  const rootPath = normalizePath(initialPath);
  const [entriesByPath, setEntriesByPath] = useState<Record<string, SandboxFileEntry[]>>(() =>
    initialEntries.length ? { [rootPath]: sortedEntries(initialEntries) } : {},
  );
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const [selectedDirectory, setSelectedDirectory] = useState(rootPath);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [selectedPath, setSelectedPath] = useState('');
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [terminalStatus, setTerminalStatus] = useState(
    running ? t('terminalConnecting') : waitingForConnector ? t('waitingForConnector') : t('terminalStopped'),
  );
  const [terminalGeneration, setTerminalGeneration] = useState(0);
  const [compactView, setCompactView] = useState<'files' | 'terminal'>('terminal');
  const [fileError, setFileError] = useState('');

  const loadDirectory = useCallback(
    async (nextPath: string) => {
      const normalized = normalizePath(nextPath);
      const raw = await callSandboxTool(rpcBase, 'list_dir', { path: normalized }, t('toolCallFailed'));
      const parsed = parseSandboxDirectoryText(raw, normalized);
      if (!parsed) throw new Error(raw);
      return {
        path: normalizePath(parsed.path || normalized),
        entries: sortedEntries(parsed.entries),
      };
    },
    [rpcBase, t],
  );

  const refreshTree = useCallback(
    async () => {
      setLoadingPath(rootPath);
      setEntriesByPath({});
      setExpandedPaths(new Set());
      setSelectedDirectory(rootPath);
      setPreview(null);
      setSelectedPath('');
      setFileError('');
      try {
        const listing = await loadDirectory(rootPath);
        setEntriesByPath({ [rootPath]: listing.entries });
      } catch (error) {
        setFileError(String(error instanceof Error ? error.message : error));
      } finally {
        setLoadingPath(null);
      }
    },
    [loadDirectory, rootPath],
  );

  useEffect(() => {
    const key = `${rpcBase}:${rootPath}`;
    if (treeScopeRef.current !== key) {
      treeScopeRef.current = key;
      loadedDirectoryRef.current = '';
      setEntriesByPath({});
      setExpandedPaths(new Set());
      setSelectedDirectory(rootPath);
      setPreview(null);
      setSelectedPath('');
      setFileError('');
    }
    if (!running || terminalOnly) return;
    if (loadedDirectoryRef.current === key) return;
    loadedDirectoryRef.current = key;
    void refreshTree();
  }, [refreshTree, rootPath, rpcBase, running, terminalOnly]);

  useEffect(() => () => {
    if (preview?.url) URL.revokeObjectURL(preview.url);
  }, [preview?.url]);

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
        setTerminalStatus(waitingForConnector ? t('waitingForConnector') : t('terminalStopped'));
        return;
      }

      const sessionRes = await fetch(terminalBase, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cols: terminal.cols, rows: terminal.rows, cwd: normalizePath(initialPath) }),
      });
      if (!sessionRes.ok) {
        terminal.writeln(`\x1b[31m${t('failedToOpenTerminal', { status: sessionRes.status })}\x1b[0m`);
        setTerminalStatus(t('terminalError'));
        return;
      }
      const session = (await sessionRes.json()) as TerminalSession;
      sessionIdRef.current = session.id;
      setTerminalStatus(t('terminalConnected'));

      eventSource = new EventSource(`${terminalBase}/${session.id}/stream`);
      eventSource.addEventListener('data', (event) => {
        if (disposed || !terminal) return;
        const payload = JSON.parse((event as MessageEvent).data) as { data?: string };
        terminal.write(payload.data ?? '');
      });
      eventSource.addEventListener('exit', (event) => {
        const payload = JSON.parse((event as MessageEvent).data) as { exitCode?: number };
        terminal?.writeln(`\r\n\x1b[33m${payload.exitCode == null
          ? t('terminalExited')
          : t('terminalExitedWithCode', { code: payload.exitCode })}\x1b[0m`);
        setTerminalStatus(t('terminalExitedStatus'));
      });
      eventSource.onerror = () => {
        if (!disposed) setTerminalStatus(t('terminalDisconnected'));
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
  }, [compactView, compact, filesOnly, flushInput, initialPath, queueInput, resizeTerminal, running, t, terminalBase, terminalGeneration, terminalOnly, waitingForConnector]);

  async function openFile(path: string) {
    setSelectedPath(path);
    setPreview(null);
    setLoadingPath(path);
    setFileError('');
    try {
      const type = previewType(path);
      if (type.kind === 'unsupported') {
        setPreview({ path, kind: type.kind });
        return;
      }
      if (type.kind === 'image' || type.kind === 'pdf') {
        const raw = await callSandboxTool(rpcBase, 'download_file', { path }, t('toolCallFailed'));
        const payload = JSON.parse(raw) as DownloadPayload;
        const { blob } = decodeBase64File(
          payload,
          path.split('/').pop() || 'sandbox-file',
          t('invalidDownloadResponse'),
          type.mimeType,
        );
        setPreview({ path, kind: type.kind, url: URL.createObjectURL(blob) });
        return;
      }
      const raw = await callSandboxTool(rpcBase, 'read_file', { path }, t('toolCallFailed'));
      const payload = JSON.parse(raw) as { content?: unknown };
      if (typeof payload.content !== 'string') throw new Error(t('filePreviewUnavailable'));
      setPreview({ path, kind: type.kind, content: payload.content });
    } catch (error) {
      setFileError(String(error instanceof Error ? error.message : error));
    } finally {
      setLoadingPath(null);
    }
  }

  async function downloadFile(path: string) {
    setLoadingPath(path);
    setFileError('');
    try {
      const raw = await callSandboxTool(rpcBase, 'download_file', { path }, t('toolCallFailed'));
      downloadBase64File(
        JSON.parse(raw) as DownloadPayload,
        path.split('/').pop() || 'sandbox-file',
        t('invalidDownloadResponse'),
      );
    } catch (error) {
      setFileError(String(error instanceof Error ? error.message : error));
    } finally {
      setLoadingPath(null);
    }
  }

  async function deleteFile(path: string) {
    if (!window.confirm(t('deleteThisFile'))) return;
    setLoadingPath(path);
    setFileError('');
    try {
      await callSandboxTool(rpcBase, 'delete_file', { path }, t('toolCallFailed'));
      if (selectedPath === path) {
        setSelectedPath('');
        setPreview(null);
      }
      const directory = parentPath(path);
      const listing = await loadDirectory(directory);
      setEntriesByPath((current) => ({ ...current, [directory]: listing.entries }));
    } catch (error) {
      setFileError(String(error instanceof Error ? error.message : error));
    } finally {
      setLoadingPath(null);
    }
  }

  async function uploadFiles(files: File[]) {
    if (!files.length || uploading) return;
    const directoryEntries = entriesByPath[selectedDirectory] ?? [];
    const existingNames = new Set(directoryEntries.map((entry) => entry.name));
    if (files.some((file) => existingNames.has(file.name)) && !window.confirm(t('replaceExistingFiles'))) return;

    setUploading(true);
    setFileError('');
    const errors: string[] = [];
    try {
      for (const file of files) {
        try {
          if (!file.name || file.name.includes('/') || file.name.includes('\\')) {
            throw new Error(t('invalidUploadFilename'));
          }
          const url = new URL(uploadBase, window.location.origin);
          url.searchParams.set('path', joinPath(selectedDirectory, file.name));
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': file.type || 'application/octet-stream' },
            body: file,
          });
          if (!response.ok) {
            const payload = await response.json().catch(() => ({})) as { error?: string };
            throw new Error(payload.error || t('toolCallFailed'));
          }
        } catch (error) {
          errors.push(`${file.name}: ${String(error instanceof Error ? error.message : error)}`);
        }
      }
      const listing = await loadDirectory(selectedDirectory);
      setEntriesByPath((current) => ({ ...current, [listing.path]: listing.entries }));
      if (errors.length) setFileError(errors.join('\n'));
    } catch (error) {
      setFileError(String(error instanceof Error ? error.message : error));
    } finally {
      setUploading(false);
      if (uploadInputRef.current) uploadInputRef.current.value = '';
    }
  }

  async function toggleDirectory(path: string) {
    setFileError('');
    setSelectedDirectory(path);
    if (expandedPaths.has(path)) {
      setExpandedPaths((current) => {
        const next = new Set(current);
        next.delete(path);
        return next;
      });
      return;
    }

    setExpandedPaths((current) => new Set(current).add(path));
    if (Object.prototype.hasOwnProperty.call(entriesByPath, path)) return;

    setLoadingPath(path);
    try {
      const listing = await loadDirectory(path);
      setEntriesByPath((current) => ({ ...current, [path]: listing.entries }));
    } catch (error) {
      setExpandedPaths((current) => {
        const next = new Set(current);
        next.delete(path);
        return next;
      });
      setFileError(String(error instanceof Error ? error.message : error));
    } finally {
      setLoadingPath(null);
    }
  }

  function renderTreeEntries(directory: string, depth: number) {
    return (entriesByPath[directory] ?? []).map((entry) => {
      const fullPath = joinPath(directory, entry.name);
      const isFolder = entry.type === 'dir';
      const expanded = isFolder && expandedPaths.has(fullPath);
      const selected = selectedPath === fullPath;
      const selectedFolder = isFolder && selectedDirectory === fullPath;
      const loading = loadingPath === fullPath;
      const children = entriesByPath[fullPath];

      return (
        <div
          key={`${entry.type}:${fullPath}`}
          role="treeitem"
          aria-expanded={isFolder ? expanded : undefined}
          aria-selected={selected || selectedFolder}
        >
          <div className={`group flex min-h-7 items-center rounded-md transition-colors ${selected || selectedFolder ? 'bg-brand-soft text-accent-foreground' : isFolder ? 'text-foreground hover:bg-muted/70' : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground'}`}>
            <button
              type="button"
              onClick={() => (isFolder ? void toggleDirectory(fullPath) : void openFile(fullPath))}
              disabled={!running || loadingPath !== null}
              aria-expanded={isFolder ? expanded : undefined}
              title={entry.name}
              style={{ paddingLeft: `${depth * 12 + 8}px` }}
              className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-2 text-left text-sm disabled:opacity-50"
            >
              {isFolder ? (
                <ChevronRight className={`size-[11px] shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} />
              ) : (
                <span aria-hidden className="size-[11px] shrink-0" />
              )}
              {loading ? (
                <Loader2 className="size-4 shrink-0 animate-spin" />
              ) : isFolder ? (
                expanded ? <FolderOpen className="size-4 shrink-0" /> : <Folder className="size-4 shrink-0" />
              ) : (
                <FileText className="size-4 shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              {!isFolder ? <span className="shrink-0 text-[10px] opacity-70">{formatSize(entry.size)}</span> : null}
            </button>
            {!isFolder ? (
              <div className="flex shrink-0 items-center pr-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                <button type="button" onClick={() => void downloadFile(fullPath)} disabled={!running || loadingPath !== null} className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-40" title={t('downloadFile')} aria-label={t('downloadFile')}><Download className="size-3.5" /></button>
                <button type="button" onClick={() => void deleteFile(fullPath)} disabled={!running || loadingPath !== null} className="rounded p-1 text-muted-foreground hover:bg-red-500/10 hover:text-red-600 disabled:opacity-40 dark:hover:text-red-300" title={t('deleteFile')} aria-label={t('deleteFile')}><Trash2 className="size-3.5" /></button>
              </div>
            ) : null}
          </div>
          {expanded ? (
            <div role="group">
              {loading ? (
                <div style={{ paddingLeft: `${(depth + 1) * 12 + 26}px` }} className="flex h-7 items-center text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /></div>
              ) : children?.length ? (
                renderTreeEntries(fullPath, depth + 1)
              ) : (
                <p style={{ paddingLeft: `${(depth + 1) * 12 + 26}px` }} className="py-1.5 pr-2 text-xs text-muted-foreground">{t('noFilesInThisDirectory')}</p>
              )}
            </div>
          ) : null}
        </div>
      );
    });
  }

  const terminalPanel = (
    <section
      className={terminalOnly || compact
        ? 'flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[#111419]'
        : 'ui-panel flex min-h-[34rem] min-w-0 flex-col overflow-hidden bg-[#111419]'}
    >
      <div className={`flex items-center justify-between gap-3 px-4 py-3 ${compact ? '' : 'border-b border-white/10'}`}>
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
              setTerminalStatus(t('terminalConnecting'));
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

  const displayedRootPath = displayWorkspacePath(rootPath, workspaceRoot);
  const rootName = displayedRootPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || displayedRootPath;
  const rootEntries = entriesByPath[rootPath];

  const filesPanel = (
    <aside className={compact ? 'flex h-full min-h-0 flex-col overflow-hidden bg-card' : 'ui-panel order-2 flex min-h-96 flex-col overflow-hidden xl:order-1'}>
      <div className={compact ? 'flex items-center justify-between gap-2 px-3 pb-2 pt-3' : 'flex items-center justify-between gap-2 border-b border-border px-3 py-3'}>
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Folder className="size-4 text-muted-foreground" />
          {t('files')}
        </div>
        <div className="flex items-center gap-1">
          <input
            ref={uploadInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => void uploadFiles(Array.from(event.target.files ?? []))}
          />
          <button type="button" onClick={() => uploadInputRef.current?.click()} disabled={!running || loadingPath !== null || uploading} className="ui-button-ghost ui-button-sm" title={t('uploadFilesTo', { path: displayWorkspacePath(selectedDirectory, workspaceRoot) })} aria-label={t('uploadFiles')}>
            {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
          </button>
          <button type="button" onClick={() => void refreshTree()} disabled={!running || loadingPath !== null || uploading} className="ui-button-ghost ui-button-sm" title={t('refreshDirectory')} aria-label={t('refreshDirectory')}>
            {loadingPath === rootPath ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          </button>
        </div>
      </div>
      <div role="tree" aria-label={t('files')} className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        <div role="treeitem" aria-expanded="true" aria-selected={selectedDirectory === rootPath}>
          <button type="button" onClick={() => setSelectedDirectory(rootPath)} title={displayedRootPath} className={`flex min-h-7 w-full items-center gap-1.5 rounded-md py-1 pl-2 pr-2 text-left text-sm font-medium ${selectedDirectory === rootPath ? 'bg-brand-soft text-accent-foreground' : 'text-foreground hover:bg-muted/70'}`}>
            <ChevronRight className="size-[11px] shrink-0 rotate-90" />
            <FolderOpen className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{rootName}</span>
          </button>
          {fileError && rootEntries ? <p role="alert" className="px-5 py-1 text-xs text-destructive">{fileError}</p> : null}
          <div role="group">
            {rootEntries?.length ? renderTreeEntries(rootPath, 1) : (
              <p className="px-5 py-5 text-sm text-muted-foreground">
                {loadingPath === rootPath
                  ? <Loader2 className="size-4 animate-spin" />
                  : !running
                    ? waitingForConnector ? t('waitingForConnectorSession') : t('startTheSandboxToBrowseFiles')
                    : rootEntries ? t('noFilesInThisDirectory') : fileError || t('noFilesInThisDirectory')}
              </p>
            )}
          </div>
        </div>
      </div>
    </aside>
  );

  const previewPanel = preview ? (
    <section className={`absolute inset-0 flex min-h-0 flex-col overflow-hidden bg-card ${compact ? '' : 'border border-border'}`}>
      <div className={`flex items-center justify-between gap-3 px-4 py-3 ${compact ? '' : 'border-b border-border'}`}>
        <button type="button" onClick={() => { setPreview(null); setSelectedPath(''); }} className="ui-button-ghost ui-icon-button shrink-0" title={t('close')} aria-label={t('close')}><ArrowLeft className="size-4" /></button>
        <div className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-foreground">{displayWorkspacePath(preview.path, workspaceRoot)}</div>
        <button type="button" onClick={() => void downloadFile(preview.path)} disabled={loadingPath !== null} className="ui-button-ghost ui-icon-button shrink-0" title={t('downloadFile')} aria-label={t('downloadFile')}><Download className="size-4" /></button>
      </div>
      {preview.kind === 'image' && preview.url ? (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted/20 p-4">
          {/* eslint-disable-next-line @next/next/no-img-element -- preview source is a short-lived local blob URL. */}
          <img src={preview.url} alt={preview.path.split('/').pop() || preview.path} className="max-h-full max-w-full object-contain" />
        </div>
      ) : preview.kind === 'pdf' && preview.url ? (
        <iframe src={preview.url} title={preview.path.split('/').pop() || preview.path} sandbox="" referrerPolicy="no-referrer" className="min-h-0 flex-1 bg-white" />
      ) : preview.kind === 'markdown' ? (
        <div className="min-h-0 flex-1 overflow-auto p-4 text-sm leading-6"><AssistantMarkdown text={preview.content ?? ''} /></div>
      ) : preview.kind === 'text' ? (
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-5 text-foreground">{preview.content}</pre>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
          <FileText className="size-10 opacity-40" />
          <p>{t('filePreviewUnavailable')}</p>
          <button type="button" onClick={() => void downloadFile(preview.path)} className="ui-button-secondary h-8 gap-2 px-3 text-xs"><Download className="size-3.5" />{t('downloadFile')}</button>
        </div>
      )}
    </section>
  ) : null;

  if (terminalOnly) return terminalPanel;

  if (filesOnly) return <div className="relative h-full min-h-0 overflow-hidden bg-background">{filesPanel}{previewPanel}</div>;

  if (compact) return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div className="grid h-10 shrink-0 grid-cols-2 bg-muted/30 p-1">
        <button type="button" onClick={() => setCompactView('terminal')} className={`flex items-center justify-center gap-2 rounded text-xs font-medium ${compactView === 'terminal' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}><TerminalIcon className="size-3.5" />{t('terminal')}</button>
        <button type="button" onClick={() => setCompactView('files')} className={`flex items-center justify-center gap-2 rounded text-xs font-medium ${compactView === 'files' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}><Folder className="size-3.5" />{t('files')}</button>
      </div>
      <div className="relative min-h-0 flex-1">{compactView === 'terminal' ? terminalPanel : filesPanel}{previewPanel}</div>
    </div>
  );

  return (
    <div className="grid min-h-[calc(100vh-13rem)] gap-4 xl:grid-cols-[18rem_minmax(0,1fr)]">
      {filesPanel}
      <div className="relative order-1 min-h-[34rem] min-w-0 xl:order-2">{terminalPanel}{previewPanel}</div>
    </div>
  );
}
