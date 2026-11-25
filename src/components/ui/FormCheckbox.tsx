"use client";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Checkbox } from "@/components/motion/checkbox";
import { cn } from "@/lib/utils";

export type FormCheckboxProps = {
  name?: string;
  value?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  label?: ReactNode;
  ariaLabel?: string;
  disabled?: boolean;
  required?: boolean;
  id?: string;
  className?: string;
};

/** Successful values and native constraints for the original beUI Checkbox. */
export function FormCheckbox({
  name,
  value = "on",
  checked,
  defaultChecked = false,
  onCheckedChange,
  label,
  ariaLabel,
  disabled,
  required,
  id,
  className,
}: FormCheckboxProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const native = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState(defaultChecked);
  const current = checked ?? selected;
  const update = (next: boolean) => {
    setSelected(next);
    onCheckedChange?.(next);
  };

  useEffect(() => {
    const form = native.current?.form;
    const reset = (event: Event) =>
      queueMicrotask(() => {
        if (!event.defaultPrevented && checked === undefined)
          setSelected(defaultChecked);
      });
    form?.addEventListener("reset", reset);
    return () => form?.removeEventListener("reset", reset);
  }, [checked, defaultChecked]);

  const stringLabel = typeof label === "string" ? label : undefined;
  const customLabel = label !== undefined && typeof label !== "string";

  return (
    <span
      className={cn(customLabel && "inline-flex items-start gap-3", className)}
    >
      <input
        ref={native}
        type="checkbox"
        name={name}
        value={value}
        checked={current}
        disabled={disabled}
        required={required}
        aria-hidden="true"
        tabIndex={-1}
        className="sr-only"
        onChange={(event) => update(event.target.checked)}
        onFocus={() => document.getElementById(controlId)?.focus()}
        onInvalid={() => document.getElementById(controlId)?.focus()}
      />
      <Checkbox
        id={controlId}
        checked={current}
        onCheckedChange={update}
        disabled={disabled}
        label={stringLabel}
        aria-label={ariaLabel}
        aria-required={required || undefined}
      />
      {customLabel ? (
        <label
          htmlFor={controlId}
          className={cn(
            "select-none text-sm text-foreground",
            disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
          )}
        >
          {label}
        </label>
      ) : null}
    </span>
  );
}
