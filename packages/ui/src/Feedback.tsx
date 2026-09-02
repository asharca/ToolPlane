import { Loader2 } from 'lucide-react';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

export type FeedbackTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger';

const badgeTones: Record<FeedbackTone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  brand: 'bg-brand-soft text-accent-foreground',
  success: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
  warning: 'bg-amber-500/14 text-amber-700 dark:text-amber-300',
  danger: 'bg-red-500/12 text-red-700 dark:text-red-300',
};

export type BadgeProps = ComponentPropsWithoutRef<'span'> & {
  tone?: FeedbackTone;
};

export function Badge({ className, tone = 'neutral', ...props }: BadgeProps) {
  return (
    <span
      data-toolplane-ui="badge"
      data-tone={tone}
      {...props}
      className={cx(
        'inline-flex min-h-5 items-center gap-1.5 rounded px-2 py-0.5 text-[11px] font-semibold',
        badgeTones[tone],
        className,
      )}
    />
  );
}

export type StatusBadgeProps = Omit<BadgeProps, 'children'> & {
  appearance?: 'badge' | 'plain';
  dot?: boolean;
  dotClassName?: string;
  label: ReactNode;
};

export function StatusBadge({
  appearance = 'badge',
  className,
  dot = true,
  dotClassName,
  label,
  tone = 'neutral',
  ...props
}: StatusBadgeProps) {
  if (appearance === 'plain') {
    return (
      <span
        {...props}
        data-toolplane-ui="status-badge"
        data-tone={tone}
        className={cx('inline-flex items-center gap-2 text-sm text-muted-foreground', className)}
      >
        {dot ? <span aria-hidden="true" className={cx('size-2 rounded-full bg-current', dotClassName)} /> : null}
        {label}
      </span>
    );
  }

  return (
    <Badge {...props} tone={tone} className={className} data-toolplane-ui="status-badge">
      {dot ? <span aria-hidden="true" className={cx('size-1.5 rounded-full bg-current', dotClassName)} /> : null}
      {label}
    </Badge>
  );
}

export type AlertTone = 'info' | 'success' | 'warning' | 'danger';

const alertTones: Record<AlertTone, string> = {
  info: 'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200',
  warning: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200',
  danger: 'border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200',
};

export type AlertProps = ComponentPropsWithoutRef<'div'> & {
  tone?: AlertTone;
};

export function Alert({ className, role, tone = 'info', ...props }: AlertProps) {
  return (
    <div
      {...props}
      data-toolplane-ui="alert"
      data-tone={tone}
      role={role ?? (tone === 'danger' ? 'alert' : 'status')}
      className={cx('rounded-md border px-4 py-3 text-sm', alertTones[tone], className)}
    />
  );
}

export type SpinnerProps = ComponentPropsWithoutRef<'span'> & {
  label?: string;
};

export function Spinner({ className, label, ...props }: SpinnerProps) {
  return (
    <span
      {...props}
      data-toolplane-ui="spinner"
      role={label ? 'status' : undefined}
      aria-hidden={label ? undefined : true}
      className={cx('inline-flex items-center gap-2', className)}
    >
      <Loader2 aria-hidden="true" className="size-4 animate-spin" />
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}
