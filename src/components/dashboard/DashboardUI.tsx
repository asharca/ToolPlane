import type { ComponentType, ReactNode } from "react";
import { Button } from "@/components/motion/button/base";
import { ButtonLink } from "@/components/motion/button/base";
import { Input } from "@/components/motion/input";
import { Search } from "lucide-react";
export {
  DashboardTable,
  type DashboardTableProps,
  type DashboardTableRow,
} from "./DashboardTable";

type Icon = ComponentType<{ className?: string }>;
const cx = (...classes: Array<string | false | null | undefined>) =>
  classes.filter(Boolean).join(" ");

export function DashboardPage({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "mx-auto w-full min-w-0 space-y-6 px-4 py-6 sm:px-6",
        className,
      )}
    >
      {children}
    </div>
  );
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
    <div
      className={cx(
        "flex flex-wrap items-center justify-between gap-3",
        className,
      )}
    >
      <div className="min-w-0">{children}</div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}

export function DashboardSearchForm({
  defaultValue,
  placeholder,
  clearHref,
  width = "sm:w-80",
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
  return (
    <form className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
      <Input
        name="q"
        type="search"
        defaultValue={defaultValue}
        placeholder={placeholder}
        aria-label={placeholder}
        leftIcon={<Search />}
        className={cx("w-full", width)}
      />
      <Button type="submit" variant="secondary">
        {submitLabel}
      </Button>
      {defaultValue?.trim() && clearHref ? (
        <ButtonLink href={clearHref} variant="ghost">
          {clearLabel}
        </ButtonLink>
      ) : null}
    </form>
  );
}

export function DashboardFilterInput({
  value,
  onChange,
  placeholder,
  width = "max-w-sm",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  width?: string;
}) {
  return (
    <Input
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      aria-label={placeholder}
      leftIcon={<Search />}
      className={cx("w-full", width)}
    />
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
    <section className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">
          {title}
          {count !== undefined ? (
            <span className="ml-2 text-muted-foreground">{count}</span>
          ) : null}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function DashboardPanel({
  title,
  description,
  children,
  tone = "default",
  padded = true,
  bodyClassName,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  tone?: "default" | "danger";
  padded?: boolean;
  bodyClassName?: string;
  className?: string;
}) {
  return (
    <section
      className={cx(
        "min-w-0 rounded-xl border border-border bg-card",
        className,
      )}
    >
      <header className="border-b border-border px-5 py-4">
        <h2
          className={cx(
            "text-sm font-semibold",
            tone === "danger" && "text-destructive",
          )}
        >
          {title}
        </h2>
        {description ? (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        ) : null}
      </header>
      <div className={cx(padded && "px-5 py-4", bodyClassName)}>{children}</div>
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
    <div
      className={cx(
        "flex min-h-48 flex-col items-center justify-center gap-3 p-6 text-center",
        className,
      )}
    >
      {Icon ? <Icon className="size-6 text-muted-foreground" /> : null}
      {title ? <h2 className="text-sm font-medium">{title}</h2> : null}
      {description ? (
        <p className="max-w-md text-sm text-muted-foreground">{description}</p>
      ) : null}
      {children}
      {actions}
    </div>
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
    <nav
      aria-label={`${previousLabel} / ${nextLabel}`}
      className="flex flex-wrap items-center justify-between gap-3"
    >
      <p className="text-sm text-muted-foreground">{summary}</p>
      <div className="flex gap-2">
        {page > 1 ? (
          <ButtonLink
            href={hrefForPage(page - 1)}
            variant="secondary"
            size="sm"
          >
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
          </ButtonLink>
        ) : null}
      </div>
    </nav>
  );
}
