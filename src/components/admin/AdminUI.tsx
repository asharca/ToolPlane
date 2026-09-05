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
  Panel,
  type FeedbackTone,
} from '@asharca/ui';

type Icon = ComponentType<{ className?: string }>;

export function AdminPage({ children, className }: { children: ReactNode; className?: string }) {
  return <Page className={`max-w-[100rem] space-y-6 ${className ?? ''}`.trim()}>{children}</Page>;
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

  return <PageHeader title={title} description={description} meta={meta} actions={actions} back={back} />;
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
      <div className="relative w-full sm:w-80">
        <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          name="q"
          defaultValue={defaultValue}
          placeholder={placeholder}
          aria-label={label}
          className="ui-input-icon h-11 w-full sm:h-9"
        />
      </div>
      <Button type="submit" variant="secondary">
        <Search aria-hidden="true" className="size-4" />
        {searchLabel}
      </Button>
      {hasQuery ? (
        <Link href={clearHref} className="ui-button-ghost">
          <X aria-hidden="true" className="size-4" />
          {clearLabel}
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
    <Link href={href} aria-label={label} className="ui-button-ghost ui-icon-button ml-auto">
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
    <Panel
      title={title}
      description={description}
      actions={actions}
      tone={tone}
      headerPresentation="bordered"
      padded={padded}
      className={className}
    >
      {children}
    </Panel>
  );
}
