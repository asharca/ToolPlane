import type { ChangeEventHandler, ComponentType, ReactNode } from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';

type Icon = ComponentType<{ className?: string }>;

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

export function DashboardPage({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cx('ui-page space-y-6', className)}>{children}</div>;
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
  return (
    <div className={cx('flex flex-wrap items-center justify-between gap-3', className)}>
      {children ? <div className="min-w-0">{children}</div> : <span />}
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function DashboardSearchForm({
  defaultValue,
  placeholder,
  clearHref,
  width = 'sm:w-80',
}: {
  defaultValue?: string;
  placeholder: string;
  clearHref?: string;
  width?: string;
}) {
  const hasQuery = Boolean(defaultValue?.trim());

  return (
    <form className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
      <div className={cx('relative w-full', width)}>
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          name="q"
          defaultValue={defaultValue}
          placeholder={placeholder}
          className="ui-input ui-input-icon h-9 w-full"
        />
      </div>
      <button className="ui-button-secondary">Search</button>
      {hasQuery && clearHref ? (
        <Link
          href={clearHref}
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          Clear
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
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <input
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className="ui-input ui-input-icon h-9 w-full"
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
  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">
          {title}
          {typeof count === 'number' ? (
            <span className="ml-1.5 font-normal text-muted-foreground">({count})</span>
          ) : null}
        </h2>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
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
  const danger = tone === 'danger';

  return (
    <section
      className={cx(
        'ui-panel overflow-hidden',
        danger && 'border-red-200 dark:border-red-500/30',
        className,
      )}
    >
      <div className={cx('border-b px-5 py-4', danger ? 'border-red-100 dark:border-red-500/20' : 'border-border')}>
        <h2 className={cx('text-sm font-semibold', danger ? 'text-red-700 dark:text-red-400' : 'text-foreground')}>
          {title}
        </h2>
        {description ? (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <div className={cx(padded && 'px-5 py-5', bodyClassName)}>{children}</div>
    </section>
  );
}

export function DashboardEmptyState({
  icon: Icon,
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
    <div className={cx('ui-empty', className)}>
      {Icon ? <Icon className="mb-3 size-8 text-muted-foreground" /> : null}
      {title ? <h2 className="text-lg font-semibold text-foreground">{title}</h2> : null}
      {description ? (
        <p className={cx('text-sm text-muted-foreground', title ? 'mt-1' : undefined)}>
          {description}
        </p>
      ) : null}
      {children ? <div className="mt-6 w-full">{children}</div> : null}
      {actions ? <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function DashboardTable({
  headers,
  children,
  minWidth = '40rem',
  panel = true,
  className,
}: {
  headers: Array<{ label?: ReactNode; className?: string; align?: 'left' | 'right' }>;
  children: ReactNode;
  minWidth?: string;
  panel?: boolean;
  className?: string;
}) {
  return (
    <div className={cx(panel ? 'ui-panel' : '', 'overflow-x-auto', className)}>
      <table className="ui-table" style={{ minWidth }}>
        <thead>
          <tr>
            {headers.map((header, index) => (
              <th
                key={index}
                className={cx(
                  'px-4 py-3 font-medium',
                  header.align === 'right' && 'text-right',
                  header.className,
                )}
              >
                {header.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">{children}</tbody>
      </table>
    </div>
  );
}

export function DashboardPagination({
  page,
  lastPage,
  total,
  label,
  hrefForPage,
}: {
  page: number;
  lastPage: number;
  total: number;
  label: string;
  hrefForPage: (page: number) => string;
}) {
  if (lastPage <= 1) return null;

  return (
    <div className="flex flex-col gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
      <span>
        Showing page {page} of {lastPage} · {total} {label}
      </span>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link href={hrefForPage(page - 1)} className="ui-button-secondary ui-button-sm">
            Prev
          </Link>
        ) : null}
        {page < lastPage ? (
          <Link href={hrefForPage(page + 1)} className="ui-button-secondary ui-button-sm">
            Next
          </Link>
        ) : null}
      </div>
    </div>
  );
}
