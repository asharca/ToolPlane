'use client';

import { Slot } from 'radix-ui';
import type {
  ButtonHTMLAttributes,
  ComponentPropsWithoutRef,
  ReactNode,
} from 'react';

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

export type ChipProps = ComponentPropsWithoutRef<'span'> & {
  active?: boolean;
  asChild?: boolean;
};

export function Chip({ active = false, asChild = false, className, ...props }: ChipProps) {
  const Component = asChild ? Slot.Root : 'span';
  return (
    <Component
      {...props}
      data-toolplane-ui="chip"
      data-active={active || undefined}
      className={cx('ui-chip', active && 'ui-chip-active', className)}
    />
  );
}

export type TabListProps = ComponentPropsWithoutRef<'div'> & {
  label: string;
};

export function TabList({ className, label, ...props }: TabListProps) {
  return (
    <div
      {...props}
      data-toolplane-ui="tab-list"
      role="tablist"
      aria-label={label}
      className={cx(
        'inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-xl bg-muted p-1 ring-1 ring-border/70',
        className,
      )}
    />
  );
}

export type TabProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  asChild?: boolean;
  count?: number;
  current?: boolean;
  navigation?: boolean;
};

export function Tab({
  asChild = false,
  children,
  className,
  count,
  current = false,
  navigation = false,
  type = 'button',
  ...props
}: TabProps) {
  const classes = cx(
    'inline-flex shrink-0 items-center gap-1.5 rounded-lg px-4 py-1.5 text-sm font-medium transition-colors',
    current
      ? 'bg-background text-foreground shadow-sm ring-1 ring-border/60'
      : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
    className,
  );

  if (asChild) {
    return (
      <Slot.Root
        {...props}
        data-toolplane-ui="tab"
        data-current={current || undefined}
        role={navigation ? undefined : 'tab'}
        aria-current={navigation && current ? 'page' : undefined}
        aria-selected={navigation ? undefined : current}
        className={classes}
      >
        {children}
      </Slot.Root>
    );
  }

  return (
    <button
      {...props}
      type={type}
      data-toolplane-ui="tab"
      data-current={current || undefined}
      role={navigation ? undefined : 'tab'}
      aria-current={navigation && current ? 'page' : undefined}
      aria-selected={navigation ? undefined : current}
      className={classes}
    >
      {children}
      {typeof count === 'number' ? (
        <span className="text-muted-foreground/70">{count}</span>
      ) : null}
    </button>
  );
}

export type TabPanelProps = ComponentPropsWithoutRef<'div'> & {
  current?: boolean;
};

export function TabPanel({ className, current = false, ...props }: TabPanelProps) {
  return (
    <div
      {...props}
      data-toolplane-ui="tab-panel"
      role="tabpanel"
      hidden={!current}
      className={className}
    />
  );
}

export type PaginationProps = Omit<ComponentPropsWithoutRef<'nav'>, 'children'> & {
  next?: ReactNode;
  previous?: ReactNode;
  summary: ReactNode;
};

export function Pagination({
  className,
  next,
  previous,
  summary,
  ...props
}: PaginationProps) {
  return (
    <nav
      {...props}
      data-toolplane-ui="pagination"
      className={cx(
        'flex flex-col gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between',
        className,
      )}
    >
      <span>{summary}</span>
      <div className="flex gap-2">
        {previous}
        {next}
      </div>
    </nav>
  );
}
