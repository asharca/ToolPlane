import type { ComponentType, ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import {
  AnimatedBadge,
  type AnimatedBadgeStatus,
} from "@/components/motion/animated-badge";
import { Button, ButtonLink } from "@/components/motion/button/base";
import { Input } from "@/components/motion/input";
import { DashboardEmptyState } from "@/components/dashboard/DashboardUI";

type Icon = ComponentType<{ className?: string }>;

export function AdminPage({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <main
      className={`mx-auto w-full min-w-0 space-y-6 px-4 py-6 sm:px-6 ${className ?? "max-w-[100rem]"}`}
    >
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
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-5">
      <div className="min-w-0 space-y-2">
        {backHref && backLabel ? (
          <ButtonLink href={backHref} variant="ghost" size="sm">
            <ArrowLeft className="size-4" />
            {backLabel}
          </ButtonLink>
        ) : null}
        <h1 className="break-words text-2xl font-semibold tracking-tight">
          {title}
        </h1>
        {description ? (
          <p className="max-w-3xl text-sm text-muted-foreground">
            {description}
          </p>
        ) : null}
        {meta}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
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
  return (
    <form className="flex w-full flex-wrap items-center gap-2">
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <Input
        name="q"
        type="search"
        defaultValue={defaultValue}
        placeholder={placeholder}
        aria-label={label}
        leftIcon={<Search />}
        className="min-w-0 flex-1 sm:max-w-md"
      />
      {children}
      <Button
        type="submit"
        variant="secondary"
        size="icon"
        aria-label={searchLabel}
        title={searchLabel}
      >
        <Search className="size-4" />
      </Button>
      {defaultValue?.trim() ? (
        <ButtonLink
          href={clearHref}
          variant="ghost"
          size="icon"
          aria-label={clearLabel}
          title={clearLabel}
        >
          <X className="size-4" />
        </ButtonLink>
      ) : null}
    </form>
  );
}

export type AdminBadgeTone = AnimatedBadgeStatus;
export function AdminBadge({
  children,
  tone = "neutral",
  dot = false,
}: {
  children: ReactNode;
  tone?: AdminBadgeTone;
  dot?: boolean;
}) {
  return (
    <AnimatedBadge status={tone} size="sm" showIcon={dot}>
      {children}
    </AnimatedBadge>
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
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-xs font-semibold">
          {initials.slice(0, 2).toUpperCase()}
        </span>
      ) : null}
      <span className="min-w-0">
        <span
          className={`block truncate text-sm font-medium ${mono ? "font-mono" : ""}`}
        >
          {title}
        </span>
        {description ? (
          <span className="mt-1 block truncate text-xs text-muted-foreground">
            {description}
          </span>
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
    <ButtonLink
      href={href}
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      className="ml-auto"
    >
      <ChevronRight className="size-4" />
    </ButtonLink>
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
  return (
    <DashboardEmptyState
      icon={icon}
      title={title}
      description={description}
      actions={actions}
      className="min-h-64"
    />
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
      className="flex flex-wrap items-center justify-between gap-3"
    >
      <p className="text-sm text-muted-foreground">
        {pageLabel} {page} / {lastPage} · {total} {itemLabel}
      </p>
      <div className="flex gap-2">
        {page > 1 ? (
          <ButtonLink
            href={hrefForPage(page - 1)}
            variant="secondary"
            size="sm"
          >
            <ChevronLeft className="size-4" />
            {previousLabel}
          </ButtonLink>
        ) : null}
        {page < lastPage ? (
          <ButtonLink
            href={hrefForPage(page + 1)}
            variant="secondary"
            size="sm"
          >
            {nextLabel}
            <ChevronRight className="size-4" />
          </ButtonLink>
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
  tone = "default",
  padded = true,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  tone?: "default" | "danger";
  padded?: boolean;
  className?: string;
}) {
  return (
    <section
      className={`min-w-0 space-y-4 border-t border-border pt-5 ${className ?? ""}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2
          className={`text-sm font-semibold ${tone === "danger" ? "text-destructive" : ""}`}
        >
          {title}
        </h2>
        {actions}
      </div>
      {description ? (
        <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>
      ) : null}
      <div className={padded ? "py-1" : undefined}>{children}</div>
    </section>
  );
}

export function AdminMetric({
  label,
  value,
  note,
  icon: Icon,
  href,
  valueClassName,
}: {
  label: string;
  value: ReactNode;
  note: ReactNode;
  icon: Icon;
  href?: string;
  valueClassName?: string;
}) {
  const content = (
    <>
      <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Icon className="size-4 shrink-0" />
        {label}
      </span>
      <strong
        className={`mt-3 block break-words text-2xl font-semibold tabular-nums ${valueClassName ?? "text-foreground"}`}
      >
        {value}
      </strong>
      <span className="mt-1.5 block text-xs text-muted-foreground">{note}</span>
    </>
  );
  return href ? (
    <Link
      href={href}
      className="block min-w-0 bg-background px-4 py-5 transition-colors hover:bg-muted/40 sm:px-5"
    >
      {content}
    </Link>
  ) : (
    <div className="min-w-0 bg-background px-4 py-5 sm:px-5">{content}</div>
  );
}
