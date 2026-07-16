import type { ComponentType, ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft, ChevronLeft, ChevronRight, Search, X } from 'lucide-react';

type Icon = ComponentType<{ className?: string }>;

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

export function AdminPage({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <main className={cx('ui-page mx-auto w-full max-w-[100rem] space-y-6', className)}>
      {children}
    </main>
  );
}

export function AdminPageHeader({
  title,
  description,
  meta,
  actions,
  backHref,
  backLabel,
}: {
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  backHref?: string;
  backLabel?: string;
}) {
  return (
    <header className="space-y-3">
      {backHref && backLabel ? (
        <Link
          href={backHref}
          className="-ml-2 inline-flex min-h-11 items-center gap-1.5 px-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground sm:ml-0 sm:min-h-0 sm:px-0"
        >
          <ArrowLeft className="size-4" />
          {backLabel}
        </Link>
      ) : null}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h1 className="text-2xl font-bold text-foreground [text-wrap:balance]">{title}</h1>
            {meta ? <span className="text-sm font-medium text-muted-foreground">{meta}</span> : null}
          </div>
          {description ? (
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground [text-wrap:pretty]">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

export function AdminSearchForm({
  defaultValue,
  placeholder,
  label,
  searchLabel,
  clearLabel,
  clearHref,
}: {
  defaultValue?: string;
  placeholder: string;
  label: string;
  searchLabel: string;
  clearLabel: string;
  clearHref: string;
}) {
  const hasQuery = Boolean(defaultValue?.trim());

  return (
    <form className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
      <label className="relative w-full sm:w-80">
        <span className="sr-only">{label}</span>
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          name="q"
          defaultValue={defaultValue}
          placeholder={placeholder}
          className="ui-input ui-input-icon h-11 w-full sm:h-9"
        />
      </label>
      <button className="ui-button-secondary">
        <Search className="size-4" />
        {searchLabel}
      </button>
      {hasQuery ? (
        <Link href={clearHref} className="ui-button-ghost">
          <X className="size-4" />
          {clearLabel}
        </Link>
      ) : null}
    </form>
  );
}

export type AdminBadgeTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger';

const BADGE_TONES: Record<AdminBadgeTone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  brand: 'bg-brand-soft text-accent-foreground',
  success: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
  warning: 'bg-amber-500/14 text-amber-700 dark:text-amber-300',
  danger: 'bg-red-500/12 text-red-700 dark:text-red-300',
};

export function AdminBadge({
  children,
  tone = 'neutral',
  dot = false,
}: {
  children: ReactNode;
  tone?: AdminBadgeTone;
  dot?: boolean;
}) {
  return (
    <span
      className={cx(
        'inline-flex min-h-5 items-center gap-1.5 rounded px-2 py-0.5 text-[11px] font-semibold',
        BADGE_TONES[tone],
      )}
    >
      {dot ? <span className="size-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

export function AdminEntity({
  title,
  description,
  initials,
  mono = false,
}: {
  title: ReactNode;
  description?: ReactNode;
  initials?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      {initials ? (
        <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-muted/45 text-[11px] font-bold text-muted-foreground">
          {initials.slice(0, 2).toUpperCase()}
        </span>
      ) : null}
      <span className="min-w-0">
        <span className={cx('block truncate font-semibold text-foreground', mono && 'font-mono text-[13px]')}>
          {title}
        </span>
        {description ? (
          <span className="block truncate text-xs text-muted-foreground">{description}</span>
        ) : null}
      </span>
    </div>
  );
}

export function AdminTableLink({
  href,
  label,
}: {
  href: string;
  label: string;
}) {
  return (
    <Link
      href={href}
      aria-label={label}
      className="ui-button-ghost ui-icon-button ml-auto"
    >
      <ChevronRight className="size-4" />
    </Link>
  );
}

export function AdminEmptyState({
  icon: Icon,
  title,
  description,
  actions,
}: {
  icon: Icon;
  title: ReactNode;
  description: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="ui-empty min-h-64">
      <Icon className="mb-3 size-8 text-muted-foreground" />
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p>
      {actions ? <div className="mt-5 flex flex-wrap justify-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function AdminPagination({
  page,
  total,
  pageSize,
  itemLabel,
  pageLabel,
  previousLabel,
  nextLabel,
  hrefForPage,
}: {
  page: number;
  total: number;
  pageSize: number;
  itemLabel: string;
  pageLabel: string;
  previousLabel: string;
  nextLabel: string;
  hrefForPage: (page: number) => string;
}) {
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  if (lastPage <= 1) return null;

  return (
    <nav
      aria-label={pageLabel}
      className="flex flex-col gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between"
    >
      <span>
        {pageLabel} {page} / {lastPage} · {total} {itemLabel}
      </span>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link href={hrefForPage(page - 1)} className="ui-button-secondary ui-button-sm">
            <ChevronLeft className="size-4" />
            {previousLabel}
          </Link>
        ) : null}
        {page < lastPage ? (
          <Link href={hrefForPage(page + 1)} className="ui-button-secondary ui-button-sm">
            {nextLabel}
            <ChevronRight className="size-4" />
          </Link>
        ) : null}
      </div>
    </nav>
  );
}

export function AdminPanel({
  title,
  description,
  actions,
  children,
  tone = 'default',
  padded = true,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  tone?: 'default' | 'danger';
  padded?: boolean;
  className?: string;
}) {
  const danger = tone === 'danger';
  return (
    <section
      className={cx(
        'ui-panel overflow-hidden',
        danger && 'ui-panel-danger',
        className,
      )}
    >
      <div
        className={cx(
          'flex min-h-14 items-center justify-between gap-3 border-b px-5 py-3.5',
          danger ? 'border-red-100 dark:border-red-500/20' : 'border-border',
        )}
      >
        <div>
          <h2 className={cx('text-sm font-semibold', danger ? 'text-destructive-text' : 'text-foreground')}>
            {title}
          </h2>
          {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </div>
      <div className={cx(padded && 'px-5 py-5')}>{children}</div>
    </section>
  );
}
