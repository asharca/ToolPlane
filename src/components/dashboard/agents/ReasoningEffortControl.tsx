"use client";

import { Brain, Check } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/motion/button";
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger,
} from "@/components/motion/popover-morph";
import {
  DEFAULT_REASONING_LEVEL,
  REASONING_LEVELS,
  type ReasoningEffort,
  type ReasoningLevel,
} from "@/lib/agents/constants";
import { cn } from "@/lib/utils";

export const REASONING_EFFORT_LABELS = {
  default: "reasoningEffortDefault",
  minimal: "reasoningEffortMinimal",
  low: "reasoningEffortLow",
  medium: "reasoningEffortMedium",
  high: "reasoningEffortHigh",
  xhigh: "reasoningEffortXHigh",
  max: "reasoningEffortMax",
} as const;

export function ReasoningEffortControl({
  value,
  inherited,
  disabled,
  onChange,
}: {
  value: ReasoningEffort;
  inherited: ReasoningLevel | null;
  disabled?: boolean;
  onChange: (value: ReasoningEffort) => void;
}) {
  const t = useTranslations("console.agents");
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  // Following the default resolves to a concrete level; there is no abstract "default".
  const fallback = inherited ?? DEFAULT_REASONING_LEVEL;
  const level = value === "default" ? fallback : value;
  const label = t(REASONING_EFFORT_LABELS[level]);
  const fullLabel = `${t("reasoningEffort")}: ${label}`;
  const selected = (option: ReasoningLevel) => option === level;
  function close() {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }
  return (
    <MorphPopover open={open && !disabled} onOpenChange={setOpen}>
      <MorphPopoverTrigger>
        <Button
          ref={trigger}
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          aria-label={fullLabel}
          title={fullLabel}
          className="h-8 shrink-0 gap-1.5 text-xs"
        >
          <Brain aria-hidden="true" className="size-3.5" />
          {label}
        </Button>
      </MorphPopoverTrigger>
      <MorphPopoverContent
        side="top"
        align="start"
        className="w-56 max-w-[calc(100vw-1rem)] p-1.5"
        onOpenAutoFocus={(content) => {
          content
            .querySelector<HTMLButtonElement>('[aria-selected="true"]')
            ?.focus({ preventScroll: true });
        }}
      >
        <div
          role="listbox"
          aria-label={t("reasoningEffort")}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
              return;
            }
            const buttons = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                '[role="option"]',
              ),
            );
            const index = buttons.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            let next: number;
            if (event.key === "ArrowDown" || event.key === "ArrowRight")
              next = (index + 1) % buttons.length;
            else if (event.key === "ArrowUp" || event.key === "ArrowLeft")
              next = (index - 1 + buttons.length) % buttons.length;
            else if (event.key === "Home") next = 0;
            else if (event.key === "End") next = buttons.length - 1;
            else return;
            event.preventDefault();
            event.stopPropagation();
            buttons[next]?.focus();
          }}
        >
          {REASONING_LEVELS.map((option) => (
            <button
              key={option}
              type="button"
              role="option"
              aria-selected={selected(option)}
              tabIndex={selected(option) ? 0 : -1}
              disabled={disabled}
              onClick={() => {
                onChange(option === fallback ? "default" : option);
                close();
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex-1">
                {t(REASONING_EFFORT_LABELS[option])}
              </span>
              {option === fallback && (
                <span className="text-xs text-muted-foreground">
                  {t("reasoningEffortDefault")}
                </span>
              )}
              <Check
                aria-hidden="true"
                className={cn(
                  "size-3.5 shrink-0",
                  !selected(option) && "invisible",
                )}
              />
            </button>
          ))}
        </div>
      </MorphPopoverContent>
    </MorphPopover>
  );
}
