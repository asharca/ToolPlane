"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/motion/select";
import { cn } from "@/lib/utils";

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

/** Keep native form values, validation and reset behind the shared dropdown. */
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
  const controlId = id ?? generatedId;
  const native = useRef<HTMLSelectElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const initial =
    defaultValue ?? options.find((option) => !option.disabled)?.value ?? "";
  const [selected, setSelected] = useState(initial);
  const current = value ?? selected;
  const currentIndex = options.findIndex((option) => option.value === current);
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
    <div className={cn("min-w-0", className)}>
      <select
        ref={native}
        name={name}
        id={`${controlId}-native`}
        value={current}
        disabled={disabled}
        required={required}
        aria-hidden="true"
        tabIndex={-1}
        className="sr-only"
        onChange={(event) => update(event.target.value)}
        onFocus={() => trigger.current?.focus()}
        onInvalid={() => trigger.current?.focus()}
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
      <Select
        // UI values are indices, so an empty native value remains selectable
        // without a magic sentinel that can collide with a caller's value.
        value={currentIndex < 0 ? "" : String(currentIndex)}
        onValueChange={(index) => {
          const option = options[Number(index)];
          if (option && !option.disabled) update(option.value);
        }}
        disabled={disabled}
      >
        <SelectTrigger
          ref={trigger}
          id={controlId}
          aria-label={label}
          aria-required={required}
        >
          <SelectValue placeholder={label}>
            {options[currentIndex]?.label}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((option, index) => (
            <SelectItem
              key={option.value}
              value={String(index)}
              disabled={option.disabled}
              textValue={option.label}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
