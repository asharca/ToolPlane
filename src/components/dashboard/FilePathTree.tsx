'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { FileTree, FileTreeFile, FileTreeFolder } from '@/components/motion/file-tree';

type PathEntry = { path: string; value: string; disabled?: boolean; directory?: boolean };
type Directory = { folders: Map<string, Directory>; files: PathEntry[] };

/** Adapts flat artifact paths to the Registry tree without changing file identities. */
export function FilePathTree({ files, ariaLabel, value, onSelect, disabled = false }: {
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
      const parts = file.path.split('/');
      if (!file.directory) parts.pop();
      let directory = root;
      for (const part of parts) {
        if (!directory.folders.has(part)) directory.folders.set(part, { folders: new Map(), files: [] });
        directory = directory.folders.get(part)!;
      }
      if (!file.directory) directory.files.push(file);
    }
    const folders: string[] = [];
    function render(directory: Directory, parent: string): ReactNode {
      return <>
        {Array.from(directory.folders, ([name, child]) => {
          const path = `${parent}/${name}`;
          const id = `folder:${path}`;
          folders.push(id);
          return <FileTreeFolder key={id} value={id} name={name || '/'} disabled={disabled}>{render(child, path)}</FileTreeFolder>;
        })}
        {directory.files.map((file) => <FileTreeFile key={file.value} value={`file:${file.value}`} name={file.path.split('/').at(-1) || file.path} disabled={disabled || file.disabled} />)}
      </>;
    }
    return { children: render(root, ''), folders };
  }, [files, disabled]);

  return <FileTree ariaLabel={ariaLabel} value={value === undefined ? selection : value === null ? null : `file:${value}`} expandedIds={folders.filter((id) => !collapsed.has(id))} onExpandedChange={(ids) => {
    const expanded = new Set(ids);
    setCollapsed(new Set(folders.filter((id) => !expanded.has(id))));
  }} onValueChange={(next) => {
    setSelection(next);
    if (next.startsWith('file:')) onSelect?.(next.slice(5));
  }}>{children}</FileTree>;
}

/** Keeps server-rendered package previews and their scoped query parameters. */
export function FilePathLinks({ files, ariaLabel, value }: {
  files: (PathEntry & { href: string })[];
  ariaLabel: string;
  value?: string | null;
}) {
  const router = useRouter();
  return <FilePathTree files={files} ariaLabel={ariaLabel} value={value} onSelect={(id) => {
    const file = files.find((entry) => entry.value === id);
    if (file) router.push(file.href, { scroll: false });
  }} />;
}

/** Read-only skill artifacts; encoded files remain encoded, never interpreted as markup. */
export function BundledFiles({ files, ariaLabel }: {
  files: { path: string; content: string; encoding?: string; size?: string }[];
  ariaLabel: string;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const file = files.find((entry) => entry.path === selected);
  return <div className="grid min-w-0 gap-3 md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
    <div className="max-h-96 min-w-0 overflow-auto p-2">
      <FilePathTree files={files.map((entry) => ({ path: entry.path, value: entry.path }))} ariaLabel={ariaLabel} value={file?.path ?? null} onSelect={setSelected} />
    </div>
    {file ? <div className="min-w-0 overflow-hidden rounded-lg border border-border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs">
        <code className="break-all">{file.path}</code>
        <span className="text-muted-foreground">{file.size ?? `${new TextEncoder().encode(file.content).length} B`}{file.encoding ? ` · ${file.encoding}` : ''}</span>
      </div>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words bg-muted/30 p-3 font-mono text-xs leading-6">{file.content}</pre>
    </div> : null}
  </div>;
}
