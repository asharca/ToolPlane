"use client";

import { Button } from "@/components/motion/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/motion/tabs";
import { useTheme } from "next-themes";

import { useTranslations } from "next-intl";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Terminal as XtermTerminal } from "@xterm/xterm";
import type { FitAddon as XtermFitAddon } from "@xterm/addon-fit";
import {
  Download,
  Folder,
  Loader2,
  RefreshCw,
  TerminalIcon,
  Trash2,
  Upload,
} from "lucide-react";
import { FilePreviewDialog } from "@/components/dashboard/FilePreviewDialog";
import { previewType } from "@/lib/file-preview";
import {
  parseSandboxDirectoryText,
  type SandboxFileEntry,
} from "@/lib/sandboxes/file-list";
import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
} from "@/components/motion/file-tree";

function terminalTheme() {
  const styles = getComputedStyle(document.documentElement);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Terminal theme requires a 2D canvas context");
  const color = (token: string) => {
    context.fillStyle = styles.getPropertyValue(token).trim();
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return `rgb(${r}, ${g}, ${b})`;
  };
  const foreground = color("--foreground");
  return {
    background: color("--background"),
    foreground,
    cursor: foreground,
    selectionBackground: color("--muted"),
  };
}

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

function textFromResult(result: RpcResult | null): string {
  return result?.content?.[0]?.text ?? JSON.stringify(result, null, 2);
}

function sortedEntries(entries: SandboxFileEntry[]): SandboxFileEntry[] {
  return [...entries].sort((a, b) =>
    a.type === b.type
      ? a.name.localeCompare(b.name)
      : a.type === "dir"
        ? -1
        : 1,
  );
}

function joinPath(base: string, name: string): string {
  const cleanBase = base === "." ? "" : base.replace(/\/+$/, "");
  return cleanBase ? `${cleanBase}/${name}` : name;
}

function parentPath(path: string): string {
  const clean = path.replace(/\/+$/, "");
  if (!clean || clean === ".") return ".";
  const parts = clean.split("/").filter(Boolean);
  parts.pop();
  return parts.length ? parts.join("/") : ".";
}

function normalizePath(path: string): string {
  const clean = path
    .replace(/\\/g, "/")
    .replace(/^\/workspace\/?/, "")
    .replace(/^\/+/, "")
    .trim();
  return clean || ".";
}

function displayWorkspacePath(
  path: string,
  workspaceRoot = "/workspace",
): string {
  const clean = normalizePath(path);
  const separator =
    workspaceRoot.includes("\\") && !workspaceRoot.includes("/") ? "\\" : "/";
  const trimmedRoot = workspaceRoot.replace(/[\\/]+$/, "") || separator;
  const root = /^[A-Za-z]:$/.test(trimmedRoot)
    ? `${trimmedRoot}${separator}`
    : trimmedRoot;
  const joiner = root.endsWith(separator) ? "" : separator;
  return clean === "."
    ? root
    : `${root}${joiner}${clean.replaceAll("/", separator)}`;
}

function formatSize(size: number | null): string {
  if (size == null) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} KB`;
  return `${Math.round(size / 1024 / 102.4) / 10} MB`;
}

function decodeBase64File(
  payload: DownloadPayload,
  fallbackName: string,
  invalidMessage: string,
  mimeType = "application/octet-stream",
) {
  if (payload.encoding !== "base64" || typeof payload.content !== "string") {
    throw new Error(invalidMessage);
  }
  const binary = atob(payload.content);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return {
    blob: new Blob([bytes], { type: mimeType }),
    filename: payload.filename || fallbackName,
  };
}

function downloadBase64File(
  payload: DownloadPayload,
  fallbackName: string,
  invalidMessage: string,
) {
  const { blob, filename } = decodeBase64File(
    payload,
    fallbackName,
    invalidMessage,
  );
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
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
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(rpcApiBase, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const json = await res.json();
  if (json.error || !res.ok)
    throw new Error(
      typeof json.error === "string"
        ? json.error
        : (json.error?.message ?? fallbackError),
    );
  const result = json.result as RpcResult | null;
  const text = textFromResult(result);
  if (result?.isError) throw new Error(text);
  return text;
}

async function postTerminal(
  terminalApiBase: string,
  sessionId: string,
  action: "input" | "resize",
  body: unknown,
) {
  await fetch(`${terminalApiBase}/${sessionId}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    keepalive: action === "input",
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
  const t = useTranslations("console.sandboxes");
  const { resolvedTheme } = useTheme();
  const terminalBase =
    terminalApiBase ?? `/api/v1/mcp/${deploymentId}/terminal`;
  const rpcBase = rpcApiBase ?? `/api/v1/mcp/${deploymentId}/rpc`;
  const uploadBase = `/api/v1/mcp/${deploymentId}/files/upload`;
  const terminalElementRef = useRef<HTMLDivElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const terminalRef = useRef<XtermTerminal | null>(null);
  const fitRef = useRef<XtermFitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const inputQueueRef = useRef("");
  const inputTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedDirectoryRef = useRef(
    initialEntries.length ? `${rpcBase}:${normalizePath(initialPath)}` : "",
  );
  const treeScopeRef = useRef(`${rpcBase}:${normalizePath(initialPath)}`);

  const rootPath = normalizePath(initialPath);
  const [entriesByPath, setEntriesByPath] = useState<
    Record<string, SandboxFileEntry[]>
  >(() =>
    initialEntries.length ? { [rootPath]: sortedEntries(initialEntries) } : {},
  );
  const [expandedPaths, setExpandedPaths] = useState<string[]>(() => [
    rootPath,
  ]);
  const [selectedDirectory, setSelectedDirectory] = useState(rootPath);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [selectedPath, setSelectedPath] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [terminalStatus, setTerminalStatus] = useState(
    running
      ? t("terminalConnecting")
      : waitingForConnector
        ? t("waitingForConnector")
        : t("terminalStopped"),
  );
  const [terminalGeneration, setTerminalGeneration] = useState(0);
  const [compactView, setCompactView] = useState<"files" | "terminal">(
    "terminal",
  );
  const [fileError, setFileError] = useState("");

  const loadDirectory = useCallback(
    async (nextPath: string) => {
      const normalized = normalizePath(nextPath);
      const raw = await callSandboxTool(
        rpcBase,
        "list_dir",
        { path: normalized },
        t("toolCallFailed"),
      );
      const parsed = parseSandboxDirectoryText(raw, normalized);
      if (!parsed) throw new Error(raw);
      return {
        path: normalizePath(parsed.path || normalized),
        entries: sortedEntries(parsed.entries),
      };
    },
    [rpcBase, t],
  );

  const refreshTree = useCallback(async () => {
    setLoadingPath(rootPath);
    setEntriesByPath({});
    setExpandedPaths([rootPath]);
    setSelectedDirectory(rootPath);
    setPreviewOpen(false);
    setSelectedPath("");
    setFileError("");
    try {
      const listing = await loadDirectory(rootPath);
      setEntriesByPath({ [rootPath]: listing.entries });
    } catch (error) {
      setFileError(String(error instanceof Error ? error.message : error));
    } finally {
      setLoadingPath(null);
    }
  }, [loadDirectory, rootPath]);

  useEffect(() => {
    const key = `${rpcBase}:${rootPath}`;
    if (treeScopeRef.current !== key) {
      treeScopeRef.current = key;
      loadedDirectoryRef.current = "";
      setEntriesByPath({});
      setExpandedPaths([rootPath]);
      setSelectedDirectory(rootPath);
      setPreviewOpen(false);
      setSelectedPath("");
      setFileError("");
    }
    if (!running || terminalOnly) return;
    if (loadedDirectoryRef.current === key) return;
    loadedDirectoryRef.current = key;
    void refreshTree();
  }, [refreshTree, rootPath, rpcBase, running, terminalOnly]);

  const flushInput = useCallback(() => {
    const sessionId = sessionIdRef.current;
    const data = inputQueueRef.current;
    if (!sessionId || !data) return;
    inputQueueRef.current = "";
    void postTerminal(terminalBase, sessionId, "input", { data });
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
    if (sessionId)
      void postTerminal(terminalBase, sessionId, "resize", {
        cols: term.cols,
        rows: term.rows,
      });
  }, [terminalBase]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Theme changes update the CSS tokens read by terminalTheme outside React.
  useEffect(() => {
    if (terminalRef.current)
      terminalRef.current.options.theme = terminalTheme();
  }, [resolvedTheme]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: View changes remount the terminal host; generation changes explicitly reconnect the session.
  useEffect(() => {
    let disposed = false;
    let eventSource: EventSource | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let terminal: XtermTerminal | null = null;

    async function mountTerminal() {
      const element = terminalElementRef.current;
      if (!element) return;
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed) return;

      const fit = new FitAddon();
      terminal = new Terminal({
        cursorBlink: true,
        fontFamily: getComputedStyle(element).fontFamily,
        fontSize: 13,
        lineHeight: 1.45,
        scrollback: 4000,
        theme: terminalTheme(),
      });
      terminal.loadAddon(fit);
      terminal.open(element);
      terminalRef.current = terminal;
      fitRef.current = fit;
      fit.fit();

      if (!running) {
        terminal.writeln(
          `\x1b[33m${
            waitingForConnector
              ? t("waitingForConnectorSession")
              : t("sandboxStoppedTerminalHint")
          }\x1b[0m`,
        );
        setTerminalStatus(
          waitingForConnector ? t("waitingForConnector") : t("terminalStopped"),
        );
        return;
      }

      const sessionRes = await fetch(terminalBase, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cols: terminal.cols,
          rows: terminal.rows,
          cwd: normalizePath(initialPath),
        }),
      });
      if (!sessionRes.ok) {
        terminal.writeln(
          `\x1b[31m${t("failedToOpenTerminal", { status: sessionRes.status })}\x1b[0m`,
        );
        setTerminalStatus(t("terminalError"));
        return;
      }
      const session = (await sessionRes.json()) as TerminalSession;
      sessionIdRef.current = session.id;
      setTerminalStatus(t("terminalConnected"));

      eventSource = new EventSource(`${terminalBase}/${session.id}/stream`);
      eventSource.addEventListener("data", (event) => {
        if (disposed || !terminal) return;
        const payload = JSON.parse((event as MessageEvent).data) as {
          data?: string;
        };
        terminal.write(payload.data ?? "");
      });
      eventSource.addEventListener("exit", (event) => {
        const payload = JSON.parse((event as MessageEvent).data) as {
          exitCode?: number;
        };
        terminal?.writeln(
          `\r\n\x1b[33m${
            payload.exitCode == null
              ? t("terminalExited")
              : t("terminalExitedWithCode", { code: payload.exitCode })
          }\x1b[0m`,
        );
        setTerminalStatus(t("terminalExitedStatus"));
      });
      eventSource.onerror = () => {
        if (!disposed) setTerminalStatus(t("terminalDisconnected"));
      };

      terminal.onData((data) => queueInput(data));
      terminal.onResize(({ cols, rows }) => {
        const sessionId = sessionIdRef.current;
        if (sessionId)
          void postTerminal(terminalBase, sessionId, "resize", { cols, rows });
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
        void fetch(`${terminalBase}/${sessionId}`, {
          method: "DELETE",
          keepalive: true,
        });
      }
      sessionIdRef.current = null;
      fitRef.current = null;
      terminalRef.current = null;
      terminal?.dispose();
    };
  }, [
    compactView,
    compact,
    filesOnly,
    flushInput,
    initialPath,
    queueInput,
    resizeTerminal,
    running,
    t,
    terminalBase,
    terminalGeneration,
    terminalOnly,
    waitingForConnector,
  ]);

  function openFile(path: string) {
    setSelectedPath(path);
    setFileError("");
    setPreviewOpen(true);
  }

  const toolCallFailed = t("toolCallFailed");
  const invalidDownloadResponse = t("invalidDownloadResponse");
  const filePreviewUnavailable = t("filePreviewUnavailable");

  const loadPreview = useCallback(
    async (signal: AbortSignal): Promise<Blob> => {
      const type = previewType(selectedPath);
      if (type.kind === "image" || type.kind === "pdf") {
        const raw = await callSandboxTool(
          rpcBase,
          "download_file",
          { path: selectedPath },
          toolCallFailed,
          signal,
        );
        return decodeBase64File(
          JSON.parse(raw) as DownloadPayload,
          selectedPath.split("/").pop() || "sandbox-file",
          invalidDownloadResponse,
          type.mimeType,
        ).blob;
      }
      const raw = await callSandboxTool(
        rpcBase,
        "read_file",
        { path: selectedPath },
        toolCallFailed,
        signal,
      );
      const payload = JSON.parse(raw) as { content?: unknown };
      if (typeof payload.content !== "string")
        throw new Error(filePreviewUnavailable);
      return new Blob([payload.content], { type: "text/plain;charset=utf-8" });
    },
    [
      rpcBase,
      selectedPath,
      toolCallFailed,
      invalidDownloadResponse,
      filePreviewUnavailable,
    ],
  );

  async function downloadFile(path: string) {
    setLoadingPath(path);
    setFileError("");
    try {
      const raw = await callSandboxTool(
        rpcBase,
        "download_file",
        { path },
        t("toolCallFailed"),
      );
      downloadBase64File(
        JSON.parse(raw) as DownloadPayload,
        path.split("/").pop() || "sandbox-file",
        t("invalidDownloadResponse"),
      );
    } catch (error) {
      setFileError(String(error instanceof Error ? error.message : error));
    } finally {
      setLoadingPath(null);
    }
  }

  async function deleteFile(path: string) {
    if (!window.confirm(t("deleteThisFile"))) return;
    setLoadingPath(path);
    setFileError("");
    try {
      await callSandboxTool(
        rpcBase,
        "delete_file",
        { path },
        t("toolCallFailed"),
      );
      if (selectedPath === path) {
        setSelectedPath("");
        setPreviewOpen(false);
      }
      const directory = parentPath(path);
      const listing = await loadDirectory(directory);
      setEntriesByPath((current) => ({
        ...current,
        [directory]: listing.entries,
      }));
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
    if (
      files.some((file) => existingNames.has(file.name)) &&
      !window.confirm(t("replaceExistingFiles"))
    )
      return;

    setUploading(true);
    setFileError("");
    const errors: string[] = [];
    try {
      for (const file of files) {
        try {
          if (
            !file.name ||
            file.name.includes("/") ||
            file.name.includes("\\")
          ) {
            throw new Error(t("invalidUploadFilename"));
          }
          const url = new URL(uploadBase, window.location.origin);
          url.searchParams.set("path", joinPath(selectedDirectory, file.name));
          const response = await fetch(url, {
            method: "POST",
            headers: {
              "content-type": file.type || "application/octet-stream",
            },
            body: file,
          });
          if (!response.ok) {
            const payload = (await response.json().catch(() => ({}))) as {
              error?: string;
            };
            throw new Error(payload.error || t("toolCallFailed"));
          }
        } catch (error) {
          errors.push(
            `${file.name}: ${String(error instanceof Error ? error.message : error)}`,
          );
        }
      }
      const listing = await loadDirectory(selectedDirectory);
      setEntriesByPath((current) => ({
        ...current,
        [listing.path]: listing.entries,
      }));
      if (errors.length) setFileError(errors.join("\n"));
    } catch (error) {
      setFileError(String(error instanceof Error ? error.message : error));
    } finally {
      setUploading(false);
      if (uploadInputRef.current) uploadInputRef.current.value = "";
    }
  }

  async function expandDirectories(paths: string[]) {
    if (!running || loadingPath !== null || uploading) return;
    setExpandedPaths(paths);
    const path = paths.find(
      (path) =>
        !expandedPaths.includes(path) && !Object.hasOwn(entriesByPath, path),
    );
    if (!path) return;
    setFileError("");
    setLoadingPath(path);
    try {
      const listing = await loadDirectory(path);
      setEntriesByPath((current) => ({ ...current, [path]: listing.entries }));
    } catch (error) {
      setExpandedPaths((current) => current.filter((entry) => entry !== path));
      setFileError(String(error instanceof Error ? error.message : error));
    } finally {
      setLoadingPath(null);
    }
  }

  function renderTreeEntries(directory: string): ReactNode {
    return (entriesByPath[directory] ?? []).map((entry) => {
      const path = joinPath(directory, entry.name);
      const disabled = !running || loadingPath !== null || uploading;
      return entry.type === "dir" ? (
        <FileTreeFolder
          key={path}
          value={path}
          name={entry.name}
          disabled={disabled}
          icon={
            loadingPath === path ? (
              <Loader2 className="size-4 animate-spin" />
            ) : undefined
          }
        >
          {renderTreeEntries(path)}
        </FileTreeFolder>
      ) : (
        <FileTreeFile
          key={path}
          value={path}
          name={entry.name}
          disabled={disabled}
        />
      );
    });
  }

  const terminalPanel = (
    <section
      className={
        terminalOnly || compact
          ? "flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background"
          : "rounded-3xl border border-border bg-card flex min-h-[34rem] min-w-0 flex-col overflow-hidden bg-background"
      }
    >
      <div
        className={`flex items-center justify-between gap-3 px-4 py-3 ${compact ? "" : "border-b border-border"}`}
      >
        <div className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
          <TerminalIcon className="size-4 text-muted-foreground" />
          {terminalLabel ?? t("terminal")}
        </div>
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span>{terminalStatus}</span>
          <span className="hidden max-w-80 truncate font-mono sm:inline">
            {terminalSubtitle ?? deploymentId}
          </span>
          <Button
            type="button"
            onClick={() => {
              setTerminalStatus(t("terminalConnecting"));
              setTerminalGeneration((value) => value + 1);
            }}
            variant="ghost"
            size="icon"
            className="shrink-0"
            title={t("reconnectTerminal")}
            aria-label={t("reconnectTerminal")}
          >
            <RefreshCw className="size-3.5" />
          </Button>
        </div>
      </div>
      <div
        ref={terminalElementRef}
        className="sandbox-terminal min-h-0 flex-1 overflow-hidden font-mono"
      />
    </section>
  );

  const displayedRootPath = displayWorkspacePath(rootPath, workspaceRoot);
  const rootName =
    displayedRootPath
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || displayedRootPath;
  const rootEntries = entriesByPath[rootPath];
  const selectedEntry = (entriesByPath[parentPath(selectedPath)] ?? []).find(
    (entry) => joinPath(parentPath(selectedPath), entry.name) === selectedPath,
  );

  const filesPanel = (
    <aside
      className={
        compact
          ? "flex h-full min-h-0 flex-col overflow-hidden bg-card"
          : "rounded-3xl border border-border bg-card order-2 flex min-h-96 flex-col overflow-hidden xl:order-1"
      }
    >
      <div
        className={
          compact
            ? "flex items-center justify-between gap-2 px-3 pb-2 pt-3"
            : "flex items-center justify-between gap-2 border-b border-border px-3 py-3"
        }
      >
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Folder className="size-4 text-muted-foreground" />
          {t("files")}
        </div>
        <div className="flex items-center gap-1">
          <input
            ref={uploadInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) =>
              void uploadFiles(Array.from(event.target.files ?? []))
            }
          />
          <Button
            type="button"
            onClick={() => uploadInputRef.current?.click()}
            disabled={!running || loadingPath !== null || uploading}
            variant="ghost"
            size="icon"
            title={t("uploadFilesTo", {
              path: displayWorkspacePath(selectedDirectory, workspaceRoot),
            })}
            aria-label={t("uploadFiles")}
          >
            {uploading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Upload className="size-3.5" />
            )}
          </Button>
          <Button
            type="button"
            onClick={() => void refreshTree()}
            disabled={!running || loadingPath !== null || uploading}
            variant="ghost"
            size="icon"
            title={t("refreshDirectory")}
            aria-label={t("refreshDirectory")}
          >
            {loadingPath === rootPath ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        <FileTree
          ariaLabel={t("files")}
          value={selectedPath || selectedDirectory}
          expandedIds={expandedPaths}
          onExpandedChange={(paths) => void expandDirectories(paths)}
          onValueChange={(path) => {
            const directory =
              path === rootPath ||
              (entriesByPath[parentPath(path)] ?? []).some(
                (entry) =>
                  joinPath(parentPath(path), entry.name) === path &&
                  entry.type === "dir",
              );
            setSelectedDirectory(directory ? path : parentPath(path));
            if (directory) {
              setSelectedPath("");
              setPreviewOpen(false);
            } else openFile(path);
          }}
        >
          <FileTreeFolder
            value={rootPath}
            name={rootName}
            disabled={!running || loadingPath !== null || uploading}
            icon={
              loadingPath === rootPath ? (
                <Loader2 className="size-4 animate-spin" />
              ) : undefined
            }
          >
            {renderTreeEntries(rootPath)}
          </FileTreeFolder>
        </FileTree>
        {fileError && !previewOpen ? (
          <p role="alert" className="px-3 py-2 text-sm text-destructive">
            {fileError}
          </p>
        ) : null}
        {!running ||
        rootEntries?.length === 0 ||
        entriesByPath[selectedDirectory]?.length === 0 ? (
          <p role="status" className="px-3 py-2 text-sm text-muted-foreground">
            {!running
              ? waitingForConnector
                ? t("waitingForConnectorSession")
                : t("startTheSandboxToBrowseFiles")
              : t("noFilesInThisDirectory")}
          </p>
        ) : null}
        {selectedPath && !previewOpen ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border p-2">
            <span className="min-w-0 break-all text-xs text-muted-foreground">
              {displayWorkspacePath(selectedPath, workspaceRoot)} ·{" "}
              {formatSize(selectedEntry?.size ?? null)}
            </span>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                onClick={() => void downloadFile(selectedPath)}
                disabled={!running || loadingPath !== null || uploading}
                variant="ghost"
                size="icon"
                aria-label={t("downloadFile")}
              >
                <Download className="size-3.5" />
              </Button>
              <Button
                type="button"
                onClick={() => void deleteFile(selectedPath)}
                disabled={!running || loadingPath !== null || uploading}
                variant="ghost"
                size="icon"
                aria-label={t("deleteFile")}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </aside>
  );

  const previewPanel = (
    <FilePreviewDialog
      open={previewOpen}
      onOpenChange={setPreviewOpen}
      name={selectedPath.split("/").pop() || selectedPath}
      size={formatSize(selectedEntry?.size ?? null)}
      load={loadPreview}
      onDownload={() => downloadFile(selectedPath)}
      error={fileError}
      actions={
        <Button
          type="button"
          onClick={() => void deleteFile(selectedPath)}
          disabled={!running || loadingPath !== null || uploading}
          variant="ghost"
          size="icon"
          title={t("deleteFile")}
          aria-label={t("deleteFile")}
        >
          <Trash2 className="size-4" />
        </Button>
      }
    />
  );

  if (terminalOnly) return terminalPanel;

  if (filesOnly)
    return (
      <div className="relative h-full min-h-0 overflow-hidden bg-background">
        {filesPanel}
        {previewPanel}
      </div>
    );

  if (compact)
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
        <Tabs
          value={compactView}
          onValueChange={(next) => setCompactView(next as "terminal" | "files")}
          className="shrink-0"
        >
          <TabsList>
            <TabsTrigger value="terminal">
              <span className="flex items-center gap-2">
                <TerminalIcon className="size-3.5" />
                {t("terminal")}
              </span>
            </TabsTrigger>
            <TabsTrigger value="files">
              <span className="flex items-center gap-2">
                <Folder className="size-3.5" />
                {t("files")}
              </span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="relative min-h-0 flex-1">
          {compactView === "terminal" ? terminalPanel : filesPanel}
          {previewPanel}
        </div>
      </div>
    );

  return (
    <div className="grid min-h-[calc(100vh-13rem)] gap-4 xl:grid-cols-[18rem_minmax(0,1fr)]">
      {filesPanel}
      <div className="relative order-1 min-h-[34rem] min-w-0 xl:order-2">
        {terminalPanel}
        {previewPanel}
      </div>
    </div>
  );
}
