import type { ChangeEventHandler, ComponentType, ReactNode } from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';
import {
  Button,
  DataTable,
  EmptyState,
  Input,
  Page,
  Pagination,
  Panel,
  Section,
  Toolbar,
} from '@asharca/ui';

type Icon = ComponentType<{ className?: string }>;

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

export function DashboardPage({ children, className }: { children: ReactNode; className?: string }) {
  return <Page as="div" className={className}>{children}</Page>;
}

export function DashboardToolbar({
  children,
  actions,
  className,
}: {
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return <Toolbar actions={actions} className={className}>{children}</Toolbar>;
}

export function DashboardSearchForm({
  defaultValue,
  placeholder,
  clearHref,
  width = 'sm:w-80',
  submitLabel,
  clearLabel,
}: {
  defaultValue?: string;
  placeholder: string;
  clearHref?: string;
  width?: string;
  submitLabel: string;
  clearLabel: string;
}) {
  const hasQuery = Boolean(defaultValue?.trim());

  return (
    <form className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
      <div className={cx('relative w-full', width)}>
        <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          name="q"
          defaultValue={defaultValue}
          placeholder={placeholder}
          aria-label={placeholder}
          className="ui-input-icon h-9 w-full"
        />
      </div>
      <Button type="submit" variant="secondary">{submitLabel}</Button>
      {hasQuery && clearHref ? (
        <Link href={clearHref} className="text-sm text-muted-foreground transition-colors hover:text-foreground">
          {clearLabel}
        </Link>
      ) : null}
    </form>
  );
}

export function DashboardFilterInput({
  value,
  onChange,
  placeholder,
  width = 'max-w-sm',
}: {
  value: string;
  onChange: ChangeEventHandler<HTMLInputElement>;
  placeholder: string;
  width?: string;
}) {
  return (
    <div className={cx('relative w-full', width)}>
      <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        aria-label={placeholder}
        className="ui-input-icon h-9 w-full"
      />
    </div>
  );
}

export function DashboardSection({
  title,
  count,
  actions,
  children,
}: {
  title: ReactNode;
  count?: number;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return <Section title={title} count={count} actions={actions}>{children}</Section>;
}

export function DashboardPanel({
  title,
  description,
  children,
  tone = 'default',
  padded = true,
  bodyClassName,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  tone?: 'default' | 'danger';
  padded?: boolean;
  bodyClassName?: string;
  className?: string;
}) {
  return (
    <Panel
      title={title}
      description={description}
      tone={tone}
      padded={false}
      bodyClassName={cx(padded && 'px-5 py-4.5', bodyClassName)}
      className={cx(tone === 'danger' && 'border-red-200 dark:border-red-500/30', className)}
    >
      {children}
    </Panel>
  );
}

export function DashboardEmptyState({
  icon,
  title,
  description,
  children,
  actions,
  className,
}: {
  icon?: Icon;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <EmptyState icon={icon} title={title} description={description} actions={actions} className={className}>
      {children}
    </EmptyState>
  );
}

export function DashboardTable({
  headers,
  children,
  minWidth = '40rem',
  panel = true,
  className,
  ariaLabel,
}: {
  headers: Array<{ label?: ReactNode; className?: string; align?: 'left' | 'right'; colSpan?: number }>;
  children: ReactNode;
  minWidth?: string;
  panel?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <DataTable headers={headers} label={ariaLabel} minWidth={minWidth} panel={panel} className={className}>
      {children}
    </DataTable>
  );
}

export function DashboardPagination({
  page,
  lastPage,
  hrefForPage,
  summary,
  previousLabel,
  nextLabel,
}: {
  page: number;
  lastPage: number;
  hrefForPage: (page: number) => string;
  summary: ReactNode;
  previousLabel: string;
  nextLabel: string;
}) {
  if (lastPage <= 1) return null;

  return (
    <Pagination
      aria-label={`${previousLabel} / ${nextLabel}`}
      summary={summary}
      previous={page > 1 ? (
        <Link href={hrefForPage(page - 1)} className="ui-button-secondary ui-button-sm">
          {previousLabel}
        </Link>
      ) : null}
      next={page < lastPage ? (
        <Link href={hrefForPage(page + 1)} className="ui-button-secondary ui-button-sm">
          {nextLabel}
        </Link>
      ) : null}
    />
  );
}
