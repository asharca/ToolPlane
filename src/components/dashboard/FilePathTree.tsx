"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
} from "@/components/motion/file-tree";
import { FilePreviewDialog } from "./FilePreviewDialog";

type PathEntry = {
  path: string;
  value: string;
  disabled?: boolean;
  directory?: boolean;
};
type Directory = { folders: Map<string, Directory>; files: PathEntry[] };

/** Adapts flat artifact paths to the Registry tree without changing file identities. */
export function FilePathTree({
  files,
  ariaLabel,
  value,
  onSelect,
  disabled = false,
}: {
  files: PathEntry[];
  ariaLabel: string;
  value?: string | null;
  onSelect?: (value: string) => void;
  disabled?: boolean;
}) {
  const [selection, setSelection] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const { children, folders } = useMemo(() => {
    const root: Directory = { folders: new Map(), files: [] };
    for (const file of files) {
      const parts = file.path.split("/");
      if (!file.directory) parts.pop();
      let directory = root;
      for (const part of parts) {
        let child = directory.folders.get(part);
        if (!child) {
          child = { folders: new Map(), files: [] };
          directory.folders.set(part, child);
        }
        directory = child;
      }
      if (!file.directory) directory.files.push(file);
    }
    const folders: string[] = [];
    function render(directory: Directory, parent: string): ReactNode {
      return (
        <>
          {Array.from(directory.folders, ([name, child]) => {
            const path = `${parent}/${name}`;
            const id = `folder:${path}`;
            folders.push(id);
            return (
              <FileTreeFolder
                key={id}
                value={id}
                name={name || "/"}
                disabled={disabled}
              >
                {render(child, path)}
              </FileTreeFolder>
            );
          })}
          {directory.files.map((file) => (
            <FileTreeFile
              key={file.value}
              value={`file:${file.value}`}
              name={file.path.split("/").at(-1) || file.path}
              disabled={disabled || file.disabled}
            />
          ))}
        </>
      );
    }
    return { children: render(root, ""), folders };
  }, [files, disabled]);

  return (
    <FileTree
      ariaLabel={ariaLabel}
      value={
        value === undefined
          ? selection
          : value === null
            ? null
            : `file:${value}`
      }
      expandedIds={folders.filter((id) => !collapsed.has(id))}
      onExpandedChange={(ids) => {
        const expanded = new Set(ids);
        setCollapsed(new Set(folders.filter((id) => !expanded.has(id))));
      }}
      onValueChange={(next) => {
        setSelection(next);
        if (next.startsWith("file:")) onSelect?.(next.slice(5));
      }}
    >
      {children}
    </FileTree>
  );
}

/** Keeps server-rendered package previews and their scoped query parameters. */
export function FilePathLinks({
  files,
  ariaLabel,
  value,
}: {
  files: (PathEntry & { href: string })[];
  ariaLabel: string;
  value?: string | null;
}) {
  const router = useRouter();
  return (
    <FilePathTree
      files={files}
      ariaLabel={ariaLabel}
      value={value}
      onSelect={(id) => {
        const file = files.find((entry) => entry.value === id);
        if (file) router.push(file.href, { scroll: false });
      }}
    />
  );
}

/** Read-only skill artifacts share the same safe preview as attachments. */
export function BundledFiles({
  files,
  ariaLabel,
}: {
  files: { path: string; content: string; encoding?: string; size?: string }[];
  ariaLabel: string;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const file = files.find((entry) => entry.path === selected);
  const load = useCallback(async () => {
    if (!file) throw new Error("File unavailable");
    return new Blob([
      file.encoding === "base64"
        ? Uint8Array.from(atob(file.content), (character) =>
            character.charCodeAt(0),
          )
        : file.content,
    ]);
  }, [file]);
  return (
    <div className="min-w-0">
      <div className="max-h-96 min-w-0 overflow-auto p-2">
        <FilePathTree
          files={files.map((entry) => ({
            path: entry.path,
            value: entry.path,
          }))}
          ariaLabel={ariaLabel}
          value={file?.path ?? null}
          onSelect={(path) => {
            setSelected(path);
            setOpen(true);
          }}
        />
      </div>
      <FilePreviewDialog
        open={open}
        onOpenChange={setOpen}
        name={file?.path ?? ""}
        size={file?.size}
        load={load}
      />
    </div>
  );
}
