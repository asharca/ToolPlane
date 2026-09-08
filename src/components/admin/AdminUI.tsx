import type { ComponentType, ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft, ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import {
  Badge,
  Button,
  EmptyState,
  Entity,
  Input,
  Page,
  PageHeader,
  Pagination,
  Section,
  type FeedbackTone,
} from '@asharca/ui';

type Icon = ComponentType<{ className?: string }>;

export function AdminPage({ children, className }: { children: ReactNode; className?: string }) {
  return <Page className={`min-w-0 space-y-6 ${className ?? 'max-w-[100rem]'}`.trim()}>{children}</Page>;
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
  const back = backHref && backLabel ? (
    <Link
      href={backHref}
      className="-ml-2 inline-flex min-h-11 items-center gap-1.5 px-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground sm:ml-0 sm:min-h-0 sm:px-0"
    >
      <ArrowLeft aria-hidden="true" className="size-4" />
      {backLabel}
    </Link>
  ) : undefined;

  return <PageHeader title={title} description={description} meta={meta} actions={actions} back={back} className="border-b border-border pb-5 [&_h1]:break-words [&_h1]:[overflow-wrap:anywhere]" />;
}

export function AdminSearchForm({
  defaultValue,
  placeholder,
  label,
  searchLabel,
  clearLabel,
  clearHref,
  hidden = {},
  children,
}: {
  defaultValue?: string;
  placeholder: string;
  label: string;
  searchLabel: string;
  clearLabel: string;
  clearHref: string;
  hidden?: Record<string, string>;
  children?: ReactNode;
}) {
  const hasQuery = Boolean(defaultValue?.trim());

  return (
    <form className="flex w-full flex-wrap items-center gap-2">
      {Object.entries(hidden).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
      <div className="relative min-w-0 flex-1 sm:max-w-md">
        <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          name="q"
          defaultValue={defaultValue}
          placeholder={placeholder}
          aria-label={label}
          className="ui-input-icon h-11 w-full sm:h-9"
        />
      </div>
      {children}
      <Button type="submit" variant="secondary" className="h-11 sm:h-9" aria-label={searchLabel} title={searchLabel}>
        <Search aria-hidden="true" className="size-4" />
      </Button>
      {hasQuery ? (
        <Link href={clearHref} className="ui-button-ghost ui-icon-button" aria-label={clearLabel} title={clearLabel}>
          <X aria-hidden="true" className="size-4" />
        </Link>
      ) : null}
    </form>
  );
}

export type AdminBadgeTone = FeedbackTone;

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
    <Badge tone={tone}>
      {dot ? <span aria-hidden="true" className="size-1.5 rounded-full bg-current" /> : null}
      {children}
    </Badge>
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
  return <Entity title={title} description={description} initials={initials} mono={mono} />;
}

export function AdminTableLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} aria-label={label} title={label} className="ui-button-ghost ui-icon-button ml-auto">
      <ChevronRight aria-hidden="true" className="size-4" />
    </Link>
  );
}

export function AdminEmptyState({
  icon,
  title,
  description,
  actions,
}: {
  icon: Icon;
  title: ReactNode;
  description: ReactNode;
  actions?: ReactNode;
}) {
  return <EmptyState icon={icon} title={title} description={description} actions={actions} className="min-h-64" />;
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
    <Pagination
      aria-label={pageLabel}
      summary={<>{pageLabel} {page} / {lastPage} · {total} {itemLabel}</>}
      previous={page > 1 ? (
        <Link href={hrefForPage(page - 1)} className="ui-button-secondary ui-button-sm">
          <ChevronLeft aria-hidden="true" className="size-4" />
          {previousLabel}
        </Link>
      ) : null}
      next={page < lastPage ? (
        <Link href={hrefForPage(page + 1)} className="ui-button-secondary ui-button-sm">
          {nextLabel}
          <ChevronRight aria-hidden="true" className="size-4" />
        </Link>
      ) : null}
    />
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
  return (
    <Section
      title={<span className={tone === 'danger' ? 'text-destructive-text' : undefined}>{title}</span>}
      actions={actions}
      className={`min-w-0 border-t pt-5 [&>div:first-child]:flex-wrap ${tone === 'danger' ? 'border-destructive/30' : 'border-border'} ${className ?? ''}`}
    >
      {description ? <p className="mb-4 max-w-3xl text-sm text-muted-foreground">{description}</p> : null}
      <div className={padded ? 'py-1' : undefined}>{children}</div>
    </Section>
  );
}

export function AdminMetric({ label, value, note, icon: Icon, href, valueClassName }: {
  label: string;
  value: ReactNode;
  note: ReactNode;
  icon: Icon;
  href?: string;
  valueClassName?: string;
}) {
  const content = <>
    <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground"><Icon className="size-4 shrink-0" />{label}</span>
    <strong className={`mt-3 block break-words text-2xl font-semibold tabular-nums ${valueClassName ?? 'text-foreground'}`}>{value}</strong>
    <span className="mt-1.5 block text-xs text-muted-foreground">{note}</span>
  </>;
  const className = 'min-w-0 bg-background px-4 py-5 sm:px-5';
  return href ? <Link href={href} className={`${className} transition-colors hover:bg-muted/40`}>{content}</Link> : <div className={className}>{content}</div>;
}
