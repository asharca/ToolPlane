"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/motion/select";

export type FormSelectProps = {
  name?: string;
  label: string;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  id?: string;
  className?: string;
};

/** HTML form participation for the original, presentation-only beUI Select. */
export function FormSelect({
  name,
  label,
  options,
  value,
  defaultValue,
  onValueChange,
  disabled,
  required,
  id,
  className,
}: FormSelectProps) {
  const generatedId = useId();
  const native = useRef<HTMLSelectElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const initial =
    defaultValue ?? options.find((option) => !option.disabled)?.value ?? "";
  const [selected, setSelected] = useState(initial);
  const current = value ?? selected;
  const update = (next: string) => {
    setSelected(next);
    onValueChange?.(next);
  };

  useEffect(() => {
    const form = native.current?.form;
    const reset = (event: Event) =>
      queueMicrotask(() => {
        if (!event.defaultPrevented && value === undefined)
          setSelected(initial);
      });
    form?.addEventListener("reset", reset);
    return () => form?.removeEventListener("reset", reset);
  }, [initial, value]);

  return (
    <div ref={root} className={className}>
      <select
        ref={native}
        name={name}
        id={id ?? generatedId}
        value={current}
        disabled={disabled}
        required={required}
        aria-hidden="true"
        tabIndex={-1}
        className="sr-only"
        onChange={(event) => update(event.target.value)}
        onFocus={() =>
          root.current
            ?.querySelector<HTMLButtonElement>(
              'button[aria-haspopup="listbox"]',
            )
            ?.focus()
        }
        onInvalid={() =>
          root.current
            ?.querySelector<HTMLButtonElement>(
              'button[aria-haspopup="listbox"]',
            )
            ?.focus()
        }
      >
        {options.map((option) => (
          <option
            key={option.value}
            value={option.value}
            disabled={option.disabled}
          >
            {option.label}
          </option>
        ))}
      </select>
      <Select value={current} onValueChange={update} disabled={disabled}>
        <SelectTrigger aria-label={label} aria-required={required}>
          <SelectValue placeholder={label} />
        </SelectTrigger>
        <SelectContent>
          <div className="max-h-[min(15rem,40dvh)] overflow-y-auto overscroll-contain">
            {options.map((option) => (
              <SelectItem
                key={option.value}
                value={option.value}
                disabled={option.disabled}
              >
                {option.label}
              </SelectItem>
            ))}
          </div>
        </SelectContent>
      </Select>
    </div>
  );
}
