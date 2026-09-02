import type {
  ComponentPropsWithoutRef,
  ComponentType,
  HTMLAttributes,
  ReactNode,
} from 'react';

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

export type PageProps = ComponentPropsWithoutRef<'main'> & {
  as?: 'div' | 'main';
};

export function Page({ as: Component = 'main', className, ...props }: PageProps) {
  return (
    <Component
      {...props}
      data-toolplane-ui="page"
      className={cx('ui-page space-y-5', className)}
    />
  );
}

export type PageHeaderProps = Omit<ComponentPropsWithoutRef<'header'>, 'title'> & {
  actions?: ReactNode;
  back?: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  title: ReactNode;
};

export function PageHeader({
  actions,
  back,
  className,
  description,
  meta,
  title,
  ...props
}: PageHeaderProps) {
  return (
    <header
      {...props}
      data-toolplane-ui="page-header"
      className={cx('space-y-3', className)}
    >
      {back}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h1 className="text-2xl font-bold text-foreground [text-wrap:balance]">{title}</h1>
            {meta ? <span className="text-sm font-medium text-muted-foreground">{meta}</span> : null}
          </div>
          {description ? (
            <div className="mt-1 max-w-3xl text-sm text-muted-foreground [text-wrap:pretty]">
              {description}
            </div>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

export type ToolbarProps = ComponentPropsWithoutRef<'div'> & {
  actions?: ReactNode;
};

export function Toolbar({ actions, children, className, ...props }: ToolbarProps) {
  return (
    <div
      {...props}
      data-toolplane-ui="toolbar"
      className={cx('flex flex-wrap items-center justify-between gap-3', className)}
    >
      {children ? <div className="min-w-0">{children}</div> : <span />}
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export type SectionProps = Omit<ComponentPropsWithoutRef<'section'>, 'title'> & {
  actions?: ReactNode;
  count?: number;
  title: ReactNode;
};

export function Section({
  actions,
  children,
  className,
  count,
  title,
  ...props
}: SectionProps) {
  return (
    <section {...props} data-toolplane-ui="section" className={className}>
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

export type PanelTone = 'default' | 'danger';
export type PanelHeaderPresentation = 'muted' | 'bordered';

export type PanelProps = Omit<ComponentPropsWithoutRef<'section'>, 'title'> & {
  actions?: ReactNode;
  bodyClassName?: string;
  description?: ReactNode;
  headerPresentation?: PanelHeaderPresentation;
  padded?: boolean;
  title: ReactNode;
  tone?: PanelTone;
};

export function Panel({
  actions,
  bodyClassName,
  children,
  className,
  description,
  headerPresentation = 'muted',
  padded = true,
  title,
  tone = 'default',
  ...props
}: PanelProps) {
  const danger = tone === 'danger';
  const bordered = headerPresentation === 'bordered';

  return (
    <section
      {...props}
      data-toolplane-ui="panel"
      data-tone={tone}
      className={cx('ui-panel overflow-hidden', danger && 'ui-panel-danger', className)}
    >
      <div
        className={cx(
          'flex items-center justify-between gap-3 px-5 py-3.5',
          bordered && 'min-h-14 border-b',
          bordered && (danger ? 'border-red-100 dark:border-red-500/20' : 'border-border'),
          !bordered && (danger ? 'bg-red-500/5' : 'bg-muted/25'),
        )}
      >
        <div className="min-w-0">
          <h2 className={cx('text-sm font-semibold', danger ? 'text-red-700 dark:text-red-400' : 'text-foreground')}>
            {title}
          </h2>
          {description ? <div className="mt-0.5 text-xs text-muted-foreground">{description}</div> : null}
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </div>
      <div className={cx(padded && 'px-5 py-5', bodyClassName)}>{children}</div>
    </section>
  );
}

type Icon = ComponentType<{ className?: string }>;

export type EmptyStateProps = Omit<ComponentPropsWithoutRef<'div'>, 'title'> & {
  actions?: ReactNode;
  description?: ReactNode;
  icon?: Icon;
  title?: ReactNode;
};

export function EmptyState({
  actions,
  children,
  className,
  description,
  icon: IconComponent,
  title,
  ...props
}: EmptyStateProps) {
  return (
    <div {...props} data-toolplane-ui="empty-state" className={cx('ui-empty', className)}>
      {IconComponent ? <IconComponent className="mb-3 size-8 text-muted-foreground" /> : null}
      {title ? <h2 className="text-lg font-semibold text-foreground">{title}</h2> : null}
      {description ? (
        <div className={cx('text-sm text-muted-foreground', Boolean(title) && 'mt-1')}>{description}</div>
      ) : null}
      {children ? <div className="mt-6 w-full">{children}</div> : null}
      {actions ? <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{actions}</div> : null}
    </div>
  );
}

export type DataTableHeader = {
  align?: 'left' | 'right';
  className?: string;
  label?: ReactNode;
};

export type DataTableProps = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
  children: ReactNode;
  headers: readonly DataTableHeader[];
  label?: string;
  minWidth?: string;
  panel?: boolean;
  tableClassName?: string;
};

export function DataTable({
  children,
  className,
  headers,
  label,
  minWidth = '40rem',
  panel = true,
  tableClassName,
  ...props
}: DataTableProps) {
  return (
    <div
      {...props}
      data-toolplane-ui="data-table"
      role={label ? 'region' : undefined}
      aria-label={label}
      tabIndex={label ? 0 : undefined}
      className={cx(
        panel && 'ui-panel',
        'relative overflow-x-auto overscroll-x-contain focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        className,
      )}
    >
      <table className={cx('ui-table', tableClassName)} style={{ minWidth }}>
        <thead>
          <tr>
            {headers.map((header, index) => (
              <th
                key={index}
                scope="col"
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

export type EntityProps = Omit<ComponentPropsWithoutRef<'div'>, 'title'> & {
  description?: ReactNode;
  initials?: string;
  mono?: boolean;
  title: ReactNode;
};

export function Entity({
  className,
  description,
  initials,
  mono = false,
  title,
  ...props
}: EntityProps) {
  return (
    <div
      {...props}
      data-toolplane-ui="entity"
      className={cx('flex min-w-0 items-center gap-3', className)}
    >
      {initials ? (
        <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-muted/45 text-[11px] font-bold text-muted-foreground">
          {initials.slice(0, 2).toUpperCase()}
        </span>
      ) : null}
      <span className="min-w-0">
        <span className={cx('block truncate font-semibold text-foreground', mono && 'font-mono text-[13px]')}>
          {title}
        </span>
        {description ? <span className="block truncate text-xs text-muted-foreground">{description}</span> : null}
      </span>
    </div>
  );
}

export type CardProps = ComponentPropsWithoutRef<'div'> & {
  muted?: boolean;
  padded?: boolean;
};

export function Card({ className, muted = false, padded = true, ...props }: CardProps) {
  return (
    <div
      {...props}
      data-toolplane-ui="card"
      className={cx(muted ? 'ui-panel-muted' : 'ui-panel', padded && 'p-5', className)}
    />
  );
}
