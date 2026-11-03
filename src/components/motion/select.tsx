"use client";

import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { Select as SelectPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { EASE_OUT } from "@/lib/ease";
import { cn } from "@/lib/utils";

export type SelectProps = ComponentProps<typeof SelectPrimitive.Root> & {
  className?: string;
};

/** Shared beUI presentation with native select keyboard and focus semantics. */
export function Select({ className, children, ...props }: SelectProps) {
  return (
    <SelectPrimitive.Root {...props}>
      <div className={cn("relative min-w-0", className)}>{children}</div>
    </SelectPrimitive.Root>
  );
}

export type SelectTriggerProps = ComponentProps<typeof SelectPrimitive.Trigger>;

export function SelectTrigger({
  className,
  children,
  ...props
}: SelectTriggerProps) {
  return (
    <SelectPrimitive.Trigger
      {...props}
      className={cn(
        "group flex h-10 w-full min-w-0 items-center justify-between gap-3 rounded-xl border border-border bg-background px-3 text-left text-sm text-foreground outline-none transition-colors",
        "hover:border-(--color-border-strong) focus-visible:ring-2 focus-visible:ring-foreground/20",
        "disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-muted-foreground",
        className,
      )}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <SelectPrimitive.Icon asChild>
        <ChevronDown
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]:rotate-180 motion-reduce:transition-none"
        />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export type SelectValueProps = ComponentProps<typeof SelectPrimitive.Value>;

export function SelectValue({ className, ...props }: SelectValueProps) {
  return (
    <SelectPrimitive.Value {...props} className={cn("truncate", className)} />
  );
}

export type SelectContentProps = ComponentProps<typeof SelectPrimitive.Content>;

export function SelectContent({
  className,
  children,
  sideOffset = 6,
  collisionPadding = 8,
  position = "popper",
  onEscapeKeyDown,
  ...props
}: SelectContentProps) {
  const reduce = useReducedMotion();
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        {...props}
        asChild
        position={position}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        onEscapeKeyDown={(event) => {
          // Escape belongs to the topmost dropdown, not its enclosing dialog.
          event.stopPropagation();
          onEscapeKeyDown?.(event);
        }}
      >
        <motion.div
          initial={reduce ? false : { opacity: 0, y: -3 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reduce ? 0 : 0.14, ease: EASE_OUT }}
          className={cn(
            "z-[9999] max-h-[min(20rem,var(--radix-select-content-available-height))] min-w-(--radix-select-trigger-width) max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-border bg-background text-foreground shadow-lg outline-none",
            className,
          )}
        >
          <SelectPrimitive.ScrollUpButton className="flex h-6 items-center justify-center bg-background text-muted-foreground">
            <ChevronUp aria-hidden="true" className="size-4" />
          </SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport className="p-1">
            {children}
          </SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className="flex h-6 items-center justify-center bg-background text-muted-foreground">
            <ChevronDown aria-hidden="true" className="size-4" />
          </SelectPrimitive.ScrollDownButton>
        </motion.div>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export type SelectItemProps = ComponentProps<typeof SelectPrimitive.Item>;

export function SelectItem({ className, children, ...props }: SelectItemProps) {
  return (
    <SelectPrimitive.Item
      {...props}
      className={cn(
        "relative flex w-full min-w-0 cursor-default select-none items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm text-muted-foreground outline-none transition-colors",
        "data-[highlighted]:bg-muted data-[highlighted]:text-foreground data-[state=checked]:text-foreground",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
    >
      <span className="min-w-0 flex-1 truncate">
        <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      </span>
      <span className="grid size-4 shrink-0 place-items-center text-foreground">
        <SelectPrimitive.ItemIndicator>
          <Check aria-hidden="true" className="size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
    </SelectPrimitive.Item>
  );
}
