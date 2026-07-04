import Link from 'next/link';
import type { ReactNode } from 'react';
import { redirect, notFound } from 'next/navigation';
import {
  ArrowLeft,
  Braces,
  CheckCircle2,
  Download,
  ExternalLink,
  FileArchive,
  FileCode2,
  GitBranch,
  Info,
  LinkIcon,
  Settings2,
  XCircle,
} from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { db } from '@/lib/db';
import { buildInstalledSkillMarkdown, installedSkillExtraFiles } from '@/lib/skills/artifact';
import { deleteCustomSkillAction, publishSkillAction, updateSkillAttributesAction } from '@/lib/skills/actions';
import { skillLabel } from '@/lib/workspace/skill-label';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { SkillMarkdownViewer } from '@/components/dashboard/SkillMarkdownViewer';

export const dynamic = 'force-dynamic';

function formatBytes(value: string): string {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function sourceLabel(source: string | null, hasCatalogSkill: boolean): string {
  if (hasCatalogSkill) return 'Catalog skill';
  if (!source) return 'Workspace skill';
  if (source === 'github') return 'GitHub import';
  if (source === 'upload') return 'Uploaded bundle';
  if (source === 'custom') return 'Custom skill';
  return source;
}

function sourceHref(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

function githubOriginalUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.hostname === 'github.com') return value;
    if (url.hostname !== 'raw.githubusercontent.com') return null;
    const [owner, repo, ref, ...path] = url.pathname.split('/').filter(Boolean);
    if (!owner || !repo || !ref || path.length === 0) return null;
    return `https://github.com/${owner}/${repo}/blob/${ref}/${path.map(encodeURIComponent).join('/')}`;
  } catch {
    return null;
  }
}

function frontmatterValue(markdown: string, key: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!match) return null;
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    if (line.slice(0, idx).trim() !== key) continue;
    const value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    return value || null;
  }
  return null;
}

function DetailItem({
  label,
  value,
  icon,
  href,
  className = '',
}: {
  label: string;
  value: string;
  icon: ReactNode;
  href?: string | null;
  className?: string;
}) {
  return (
    <div className={`min-w-0 rounded-md border border-border bg-muted/20 p-3 ${className}`}>
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </div>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="block break-all text-sm font-medium text-foreground underline-offset-4 hover:underline"
        >
          {value}
        </a>
      ) : (
        <p className="break-words text-sm font-medium text-foreground">{value}</p>
      )}
    </div>
  );
}

function BooleanPill({ value, label }: { value: boolean; label: string }) {
  const Icon = value ? CheckCircle2 : XCircle;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium ${
        value
          ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/70 dark:bg-emerald-950/40 dark:text-emerald-300'
          : 'border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400'
      }`}
    >
      <Icon className="size-3.5" />
      {label}
    </span>
  );
}

function StatusPill({ status }: { status: string }) {
  const published = status === 'published';
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-semibold capitalize ${
        published
          ? 'border-brand/30 bg-brand/10 text-brand'
          : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/70 dark:bg-amber-950/40 dark:text-amber-300'
      }`}
    >
      {status}
    </span>
  );
}

const controlInput =
  'h-9 rounded-md border border-border bg-card px-3 text-sm text-foreground outline-none transition-colors focus:border-ring';

export default async function SkillInspectorPage({
  params,
}: {
  params: Promise<{ workspace: string; installId: string }>;
}) {
  const { workspace: slug, installId } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');

  const install = await db.installedSkill.findFirst({
    where: { id: installId, workspaceId: ws.id },
    include: {
      skill: {
        select: { slug: true, name: true, description: true, author: true, githubSource: true, content: true, files: true },
      },
    },
  });
  if (!install) notFound();

  const isCustom = !install.skillId;
  const label = skillLabel(install);
  const markdown = buildInstalledSkillMarkdown(install);
  const markdownDescription = frontmatterValue(markdown, 'description');
  let extraFiles: { path: string; content: string }[] = [];
  try {
    extraFiles = installedSkillExtraFiles(install);
  } catch {
    extraFiles = [];
  }
  const githubOriginal = githubOriginalUrl(install.sourceRef) || githubOriginalUrl(install.skill?.githubSource);
  const sourceRef = install.sourceRef || install.skill?.githubSource || null;
  const sourceRefHref = sourceHref(sourceRef);
  const downloadHref = `/api/v1/skills/${install.id}/download`;
  const rawData = {
    id: install.id,
    slug: label.slug,
    name: label.name,
    description: install.description,
    status: install.status,
    source: install.source,
    sourceRef: install.sourceRef,
    skillId: install.skillId,
    userInvocable: install.userInvocable,
    agentInvocable: install.agentInvocable,
    effort: install.effort,
    createdAt: install.createdAt.toISOString(),
    catalogSkill: install.skill
      ? {
          slug: install.skill.slug,
          name: install.skill.name,
          description: install.skill.description,
          author: install.skill.author,
          githubSource: install.skill.githubSource,
          hasStoredSkillMd: Boolean(install.skill.content),
          bundledFiles: Array.isArray(install.skill.files) ? install.skill.files.length : 0,
        }
      : null,
    files: extraFiles.map((file) => ({
      path: file.path,
      bytes: Buffer.byteLength(file.content, 'utf8'),
    })),
  };

  return (
    <>
      <DashboardHeader
        title={label.name}
        actions={
          <Link
            href={`/app/${slug}/skills`}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-zinc-200 px-3 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            <ArrowLeft className="size-4" />
            Back
          </Link>
        }
      />
      <div className="ui-page w-full max-w-none space-y-5">
        <section className="ui-panel overflow-hidden">
          <div className="border-b border-border px-5 py-4 sm:px-6">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <StatusPill status={install.status} />
                  <span className="rounded-md border border-border bg-muted/30 px-2.5 py-1 text-xs font-medium text-muted-foreground">
                    {sourceLabel(install.source, Boolean(install.skillId))}
                  </span>
                  {extraFiles.length ? (
                    <span className="rounded-md border border-border bg-muted/30 px-2.5 py-1 text-xs font-medium text-muted-foreground">
                      {extraFiles.length} bundled files
                    </span>
                  ) : null}
                </div>
                <h1 className="break-words text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                  {label.name}
                </h1>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
                  {markdownDescription || install.description || install.skill?.description || 'No description provided.'}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {githubOriginal ? (
                  <a
                    href={githubOriginal}
                    target="_blank"
                    rel="noreferrer"
                    className="ui-button-secondary"
                  >
                    <ExternalLink className="size-4" />
                    Open GitHub
                  </a>
                ) : null}
                <a href={downloadHref} className="ui-button-primary">
                  <Download className="size-4" />
                  Download
                </a>
              </div>
            </div>
          </div>

          <div className="grid gap-3 p-5 sm:grid-cols-2 sm:p-6 xl:grid-cols-4">
            <DetailItem
              label="Slug"
              value={label.slug}
              icon={<FileCode2 className="size-3.5" />}
            />
            <DetailItem
              label="Source"
              value={sourceLabel(install.source, Boolean(install.skillId))}
              icon={<GitBranch className="size-3.5" />}
            />
            <DetailItem
              label="Created"
              value={formatDate(install.createdAt)}
              icon={<Info className="size-3.5" />}
            />
            <DetailItem
              label="SKILL.md size"
              value={formatBytes(markdown)}
              icon={<FileArchive className="size-3.5" />}
            />
            <DetailItem
              label="GitHub original"
              value={githubOriginal || sourceRef || 'none'}
              href={githubOriginal || sourceRefHref}
              icon={<LinkIcon className="size-3.5" />}
              className="sm:col-span-2"
            />
            <DetailItem
              label="Effort"
              value={install.effort || 'default'}
              icon={<Settings2 className="size-3.5" />}
            />
            <DetailItem
              label="Install ID"
              value={install.id}
              icon={<Braces className="size-3.5" />}
            />
            <DetailItem
              label="Bundle files"
              value={String(extraFiles.length)}
              icon={<FileArchive className="size-3.5" />}
            />
          </div>

          <div className="flex flex-wrap gap-2 border-t border-border px-5 py-4 sm:px-6">
            <BooleanPill value={install.userInvocable} label="User invocable" />
            <BooleanPill value={install.agentInvocable} label="Agent invocable" />
          </div>

          {isCustom ? (
            <div className="border-t border-border px-5 py-4 sm:px-6">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Workspace controls
                </p>
                <div className="flex flex-wrap gap-2">
                  <form action={publishSkillAction}>
                    <input type="hidden" name="workspace" value={slug} />
                    <input type="hidden" name="installId" value={install.id} />
                    <button className="ui-button-secondary ui-button-sm">
                      {install.status === 'published' ? 'Unpublish' : 'Publish'}
                    </button>
                  </form>
                  <form action={deleteCustomSkillAction}>
                    <input type="hidden" name="workspace" value={slug} />
                    <input type="hidden" name="installId" value={install.id} />
                    <button className="ui-button-secondary ui-button-sm text-red-600 hover:border-red-200 hover:text-red-700 dark:text-red-300">
                      Delete
                    </button>
                  </form>
                </div>
              </div>

              <form action={updateSkillAttributesAction} className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="workspace" value={slug} />
                <input type="hidden" name="installId" value={install.id} />
                <label className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm text-foreground">
                  <input type="checkbox" name="userInvocable" defaultChecked={install.userInvocable} />
                  User
                </label>
                <label className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm text-foreground">
                  <input type="checkbox" name="agentInvocable" defaultChecked={install.agentInvocable} />
                  Agent
                </label>
                <label className="space-y-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Effort
                  <select name="effort" defaultValue={install.effort} className={`${controlInput} mt-1 w-full`}>
                    <option value="default">default</option>
                    <option value="low">low</option>
                    <option value="high">high</option>
                  </select>
                </label>
                <button className="ui-button-primary h-9">Save</button>
              </form>
            </div>
          ) : null}
        </section>

        <SkillMarkdownViewer
          markdown={markdown}
          downloadHref={downloadHref}
          editable={isCustom ? { workspace: slug, installId: install.id, content: markdown } : undefined}
        />

        {extraFiles.length ? (
          <section className="ui-panel overflow-hidden">
            <div className="border-b border-border px-5 py-4 sm:px-6">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Bundle files
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Files that will be synced next to `SKILL.md`.
              </p>
            </div>
            <div className="divide-y divide-border">
              {extraFiles.map((file) => (
                <details key={file.path} className="group">
                  <summary className="flex cursor-pointer list-none flex-col gap-1 px-5 py-3 text-sm transition-colors hover:bg-muted/40 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                    <span className="min-w-0 break-all font-mono text-foreground">
                      {file.path}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatBytes(file.content)}
                    </span>
                  </summary>
                  <pre className="max-h-96 overflow-auto border-t border-border bg-muted/30 p-5 font-mono text-xs leading-6 text-foreground sm:p-6">
                    {file.content}
                  </pre>
                </details>
              ))}
            </div>
          </section>
        ) : (
          <section className="ui-panel-muted px-5 py-4 text-sm text-muted-foreground sm:px-6">
            No bundled files. This skill syncs as a single `SKILL.md` file.
          </section>
        )}

        <section className="ui-panel overflow-hidden">
          <div className="border-b border-border px-5 py-4 sm:px-6">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Raw skill data
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Database fields used by install, agent prompts, and toolkit sync.
            </p>
          </div>
          <pre className="max-h-96 overflow-auto bg-muted/30 p-5 font-mono text-xs leading-6 text-foreground sm:p-6">
            {JSON.stringify(rawData, null, 2)}
          </pre>
        </section>
      </div>
    </>
  );
}
