"use client";
// asharca.github.io/ui/components/agents/ai-artifacts

import { useId, useState } from "react";
import {
  Code2,
  Copy,
  Download,
  FileText,
  History,
  RotateCcw,
  X,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArtifactCodeView,
  ArtifactMarkdown,
  type ArtifactMarkdownLabels,
} from "@/components/agents/ai-artifacts-markdown";
import type { AgentCodeLanguage } from "@/components/agents/agent-code";
import { Button } from "@/components/motion/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/motion/tabs";
import { PresenceGate } from "@/lib/presence-gate";
import { EASE_OUT } from "@/lib/ease";
import { cn } from "@/lib/utils";

export interface ArtifactVersion {
  id: string;
  label: string;
  content: string;
}
type ArtifactKind = "code" | "document";
/** Every user-visible string; pass a partial object to localize or reword. */
export interface AIArtifactLabels extends ArtifactMarkdownLabels {
  artifact: (kind: ArtifactKind) => string;
  markdownDocument: string;
  copy: (kind: ArtifactKind) => string;
  download: (kind: ArtifactKind) => string;
  versionHistory: string;
  closeArtifact: string;
  closeVersionHistory: string;
  preview: string;
  edit: string;
  unsavedChanges: string;
  noVersions: string;
  documentContent: string;
  historyLocked: string;
  historyHint: string;
  firstDraft: string;
  savedRevision: string;
  lines: (count: number) => string;
  words: (count: number) => string;
  discard: string;
  saveVersion: string;
  saving: string;
  editingMarkdown: string;
  allChangesSaved: string;
  copied: string;
  downloaded: string;
  saved: string;
  clipboardUnavailable: string;
  copyFailed: string;
  saveFailed: string;
}
export const defaultAIArtifactLabels: AIArtifactLabels = {
  artifact: (kind) => (kind === "code" ? "Code artifact" : "Document artifact"),
  markdownDocument: "Markdown document",
  copyCode: "Copy",
  codeCopied: "Copied",
  plainText: "text",
  taskDone: "Done",
  taskOpen: "Not done",
  copy: (kind) => `Copy ${kind}`,
  download: (kind) => `Download ${kind}`,
  versionHistory: "Version history",
  closeArtifact: "Close artifact",
  closeVersionHistory: "Close version history",
  preview: "Preview",
  edit: "Edit",
  unsavedChanges: "Unsaved changes",
  noVersions: "No artifact versions available.",
  documentContent: "Document content",
  historyLocked: "Save or discard edits before switching versions.",
  historyHint: "Open an earlier draft to review or continue from it.",
  firstDraft: "First draft",
  savedRevision: "Saved revision",
  lines: (count) => `${count} lines`,
  words: (count) => `${count} words`,
  discard: "Discard",
  saveVersion: "Save version",
  saving: "Saving…",
  editingMarkdown: "Editing Markdown",
  allChangesSaved: "All changes saved",
  copied: "Copied current content",
  downloaded: "Downloaded current content",
  saved: "Document saved",
  clipboardUnavailable: "Clipboard unavailable. Select the text to copy it.",
  copyFailed: "Copy failed",
  saveFailed: "Save failed; your edits are preserved.",
};
export interface AIArtifactProps {
  title: string;
  filename: string;
  versions: ArtifactVersion[];
  kind: ArtifactKind;
  language?: AgentCodeLanguage;
  version?: string;
  defaultVersion?: string;
  onVersionChange?: (id: string) => void;
  /** Saving is host-owned; append the saved revision to versions after success. */
  onSave?: (content: string, baseVersion: string) => void | Promise<void>;
  onCopy?: (content: string) => void | Promise<void>;
  onClose?: () => void;
  labels?: Partial<AIArtifactLabels>;
  className?: string;
}

export function AIArtifact({
  title,
  filename,
  versions,
  kind,
  language = "typescript",
  version,
  defaultVersion,
  onVersionChange,
  onSave,
  onCopy,
  onClose,
  labels,
  className,
}: AIArtifactProps) {
  const id = useId();
  const reduce = useReducedMotion();
  const l = { ...defaultAIArtifactLabels, ...labels };
  const [internalVersion, setVersion] = useState(defaultVersion);
  const current =
    versions.find((item) => item.id === (version ?? internalVersion)) ??
    versions.at(-1);
  const [edit, setEdit] = useState<{ base: string; text: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const content =
    edit && current && edit.base === current.id
      ? edit.text
      : (current?.content ?? "");
  const dirty = Boolean(current && content !== current.content);
  const choose = (next: string) => {
    if (saving || dirty) return;
    if (version === undefined) setVersion(next);
    onVersionChange?.(next);
    setEdit(null);
    setEditing(false);
    setMessage("");
    setError("");
  };
  const copy = async () => {
    setError("");
    setMessage("");
    try {
      if (onCopy) await onCopy(content);
      else {
        if (!navigator.clipboard) throw new Error(l.clipboardUnavailable);
        await navigator.clipboard.writeText(content);
      }
      setMessage(l.copied);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : l.copyFailed);
    }
  };
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([content], {
        type:
          kind === "document"
            ? "text/markdown;charset=utf-8"
            : "text/plain;charset=utf-8",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setMessage(l.downloaded);
  };
  const save = async () => {
    if (!current || !onSave || saving) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      await onSave(content, current.id);
      setEdit(null);
      setMessage(l.saved);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : l.saveFailed);
    } finally {
      setSaving(false);
    }
  };
  return (
    <section
      aria-label={l.artifact(kind)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && history) {
          event.stopPropagation();
          setHistory(false);
        }
      }}
      className={cn(
        "w-full min-w-0 overflow-hidden rounded-2xl border border-border bg-background text-foreground",
        className,
      )}
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted">
            {kind === "code" ? (
              <Code2 className="size-4 text-muted-foreground" />
            ) : (
              <FileText className="size-4 text-muted-foreground" />
            )}
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-medium">
              {kind === "code" ? filename : title}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {kind === "code" ? title : l.markdownDocument}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label={l.copy(kind)}
            title={l.copy(kind)}
            disabled={!current}
            onClick={copy}
          >
            <Copy className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={l.download(kind)}
            title={l.download(kind)}
            disabled={!current}
            onClick={download}
          >
            <Download className="size-4" />
          </Button>
          {kind === "document" ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label={l.versionHistory}
              title={l.versionHistory}
              aria-expanded={history}
              aria-controls={`${id}-history`}
              onClick={() => setHistory((value) => !value)}
            >
              <History className="size-4" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              aria-label={l.closeArtifact}
              disabled={!onClose}
              onClick={onClose}
            >
              <X className="size-4" />
            </Button>
          )}
        </div>
      </header>
      {kind === "document" && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-1.5">
          <Tabs
            value={editing ? "edit" : "preview"}
            onValueChange={(mode) => setEditing(mode === "edit")}
          >
            <TabsList>
              <TabsTrigger
                value="preview"
                disabled={saving}
                indicatorClassName="bg-background shadow-sm"
                className="w-20 text-xs [&_[data-tabs-label]]:text-foreground"
              >
                {l.preview}
              </TabsTrigger>
              {onSave && (
                <TabsTrigger
                  value="edit"
                  disabled={!current || saving}
                  indicatorClassName="bg-background shadow-sm"
                  className="w-20 text-xs [&_[data-tabs-label]]:text-foreground"
                >
                  {l.edit}
                </TabsTrigger>
              )}
            </TabsList>
          </Tabs>
          <span className="text-xs text-muted-foreground">
            {dirty ? l.unsavedChanges : current?.label}
          </span>
        </div>
      )}
      <div className="relative isolate">
        {!current ? (
          <p className="p-6 text-sm text-muted-foreground">{l.noVersions}</p>
        ) : kind === "code" ? (
          <div className="max-h-[min(70vh,40rem)] overflow-auto overscroll-contain">
            <ArtifactCodeView code={current.content} language={language} />
          </div>
        ) : editing ? (
          <div className="h-80 px-5 py-5 sm:px-6">
            <textarea
              aria-label={l.documentContent}
              value={content}
              disabled={saving}
              onChange={(event) =>
                setEdit({ base: current.id, text: event.target.value })
              }
              className="h-full min-h-64 w-full resize-none rounded-lg bg-transparent p-2 font-mono text-[13px] leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
        ) : (
          <div className="max-h-[min(70vh,40rem)] min-h-48 overflow-auto overscroll-contain px-5 py-6 sm:px-8">
            <ArtifactMarkdown content={content} labels={l} />
          </div>
        )}
        <AnimatePresence initial={false}>
          {history && (
            <PresenceGate>
              {({ gate }) => (
                <motion.section
                  {...gate}
                  id={`${id}-history`}
                  aria-label={l.versionHistory}
                  initial={reduce ? false : { opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: reduce ? 0 : 20 }}
                  transition={{ duration: 0.18, ease: EASE_OUT }}
                  className="absolute inset-y-0 right-0 z-10 w-full max-w-xs overflow-y-auto border-l border-border bg-background p-5"
                >
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <h3 className="text-sm font-medium">{l.versionHistory}</h3>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={l.closeVersionHistory}
                      onClick={() => setHistory(false)}
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                  <p className="mb-4 text-xs leading-5 text-muted-foreground">
                    {dirty ? l.historyLocked : l.historyHint}
                  </p>
                  <div className="space-y-2">
                    {versions.toReversed().map((item, index) => (
                      <button
                        key={item.id}
                        type="button"
                        disabled={saving || dirty}
                        aria-pressed={current?.id === item.id}
                        onClick={() => choose(item.id)}
                        className={cn(
                          "w-full rounded-xl border border-border p-3 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                          current?.id === item.id && "bg-muted/50",
                        )}
                      >
                        <span className="block font-medium">{item.label}</span>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {index === versions.length - 1
                            ? l.firstDraft
                            : l.savedRevision}
                        </span>
                      </button>
                    ))}
                  </div>
                </motion.section>
              )}
            </PresenceGate>
          )}
        </AnimatePresence>
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
        <span>
          {kind === "code"
            ? l.lines(content.replace(/\n$/, "").split("\n").length)
            : l.words(content.trim().split(/\s+/).filter(Boolean).length)}
        </span>
        {kind === "document" && dirty && onSave ? (
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() => setEdit(null)}
              className="h-7 rounded-full text-xs"
            >
              <RotateCcw className="size-3" />
              {l.discard}
            </Button>
            <Button
              size="sm"
              disabled={saving}
              onClick={save}
              className="h-7 rounded-full text-xs"
            >
              {saving ? l.saving : l.saveVersion}
            </Button>
          </div>
        ) : (
          <span>
            {kind === "code"
              ? current?.label
              : editing
                ? l.editingMarkdown
                : l.allChangesSaved}
          </span>
        )}
        <span role="status" className="sr-only">
          {message}
        </span>
        {error && (
          <p role="alert" className="w-full text-destructive">
            {error}
          </p>
        )}
      </footer>
    </section>
  );
}
