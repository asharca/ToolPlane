"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Button, type ButtonProps } from "@/components/motion/button/base";
import { CenterMorphModalClose } from "@/components/motion/center-morph-modal";
import { FormSelect } from "@/components/ui/FormSelect";
import { cn } from "@/lib/utils";

export function DialogHeader({
  title,
  description,
  icon,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("shrink-0 px-6 pt-5 pb-4 pr-12", className)}>
      <h2 className="flex items-center gap-2 text-base font-semibold">
        {icon}
        {title}
      </h2>
      {description ? (
        <div className="mt-2 text-sm text-muted-foreground">{description}</div>
      ) : null}
    </header>
  );
}

export function DialogBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function DialogFooter({
  start,
  cancel,
  children,
  className,
}: {
  start?: ReactNode;
  cancel?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <footer
      className={cn(
        "sticky bottom-0 z-10 flex shrink-0 items-center gap-3 border-t border-border bg-background px-6 py-4 [&_button]:h-10 [&_button]:text-sm",
        className,
      )}
    >
      {start ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">{start}</div>
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {cancel}
        {children}
      </div>
    </footer>
  );
}

export function DialogCancel({ children, onClick, ...props }: ButtonProps) {
  const t = useTranslations("common");
  return (
    <CenterMorphModalClose>
      <Button
        {...props}
        type="button"
        variant="ghost"
        size="md"
        onClick={onClick}
      >
        {children ?? t("cancel")}
      </Button>
    </CenterMorphModalClose>
  );
}

export type DialogNavItem = {
  id: string;
  label: string;
  icon?: ReactNode;
  dirty?: boolean;
};

export function DialogNav({
  items,
  active,
  onSelect,
  label,
  className,
}: {
  items: DialogNavItem[];
  active: string;
  onSelect: (id: string) => void;
  label?: string;
  className?: string;
}) {
  const t = useTranslations("common");
  const navLabel = label ?? t("edit");
  return (
    <aside
      className={cn(
        "shrink-0 border-b border-border p-3 md:w-56 md:border-r md:border-b-0",
        className,
      )}
    >
      <FormSelect
        label={navLabel}
        value={active}
        onValueChange={onSelect}
        className="md:hidden"
        options={items.map((item) => ({
          value: item.id,
          label: item.dirty ? `${item.label} · ${t("modified")}` : item.label,
        }))}
      />
      <nav aria-label={navLabel} className="hidden space-y-1 md:block">
        {items.map((item) => (
          <Button
            key={item.id}
            type="button"
            size="md"
            variant="ghost"
            aria-current={active === item.id ? "page" : undefined}
            onClick={() => onSelect(item.id)}
            className={cn(
              "h-9 w-full justify-start rounded-lg px-3 text-sm [&_svg]:size-4",
              active === item.id && "bg-muted font-medium text-foreground",
            )}
          >
            {item.icon}
            <span className="min-w-0 truncate">{item.label}</span>
            {item.dirty ? (
              <span
                className="ml-auto size-1.5 shrink-0 rounded-full bg-primary"
                role="img"
                aria-label={t("modified")}
              />
            ) : null}
          </Button>
        ))}
      </nav>
    </aside>
  );
}

export function DialogField({
  label,
  htmlFor,
  description,
  dirty,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  description?: ReactNode;
  dirty?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const t = useTranslations("common");
  return (
    <div
      data-dialog-field=""
      data-dirty={dirty ? "true" : undefined}
      data-dialog-field-controlled={dirty !== undefined ? "" : undefined}
      className={cn("group/dialog-field relative space-y-2", className)}
    >
      <label
        htmlFor={htmlFor}
        className="flex flex-wrap items-center gap-2 text-sm font-medium"
      >
        {label}
        <span className="hidden rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary group-data-[dirty=true]/dialog-field:inline-block">
          {t("modified")}
        </span>
      </label>
      <div className="rounded-lg [[data-dirty=true]_&]:ring-1 [[data-dirty=true]_&]:ring-primary/50">
        {children}
      </div>
      {description ? (
        <div className="text-xs text-muted-foreground">{description}</div>
      ) : null}
    </div>
  );
}
