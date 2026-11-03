"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  isNativeFieldDirty,
  type NativeFormField,
} from "@/lib/forms/dirty-fields";

const FIELD_SELECTOR = "input[name], select[name], textarea[name]";

/** Track native defaults; pass explicit dirty state for controlled/custom controls. */
export function useDirtyFields(formRef: RefObject<HTMLFormElement | null>) {
  const [dirtyNames, setDirtyNames] = useState<Set<string>>(() => new Set());
  const previousForm = useRef<HTMLFormElement | null>(null);

  const update = useCallback(() => {
    const form = formRef.current;
    if (!form) return;
    const names = new Set<string>();
    const wrappers = new Map<HTMLElement, boolean>();
    for (const field of form.querySelectorAll<NativeFormField>(
      FIELD_SELECTOR,
    )) {
      const dirty = isNativeFieldDirty(field);
      if (dirty) {
        field.dataset.dirty = "true";
        names.add(field.name);
      } else {
        delete field.dataset.dirty;
      }
      const wrapper = field.closest<HTMLElement>("[data-dialog-field]");
      if (wrapper && !wrapper.hasAttribute("data-dialog-field-controlled")) {
        wrappers.set(wrapper, Boolean(wrappers.get(wrapper)) || dirty);
      }
    }
    for (const [wrapper, dirty] of wrappers) {
      if (dirty) wrapper.dataset.dirty = "true";
      else delete wrapper.dataset.dirty;
    }
    setDirtyNames((previous) =>
      previous.size === names.size &&
      [...names].every((name) => previous.has(name))
        ? previous
        : names,
    );
  }, [formRef]);

  const reset = useCallback(() => {
    const form = formRef.current;
    if (!form) return;
    for (const field of form.querySelectorAll<NativeFormField>(
      FIELD_SELECTOR,
    )) {
      if (field instanceof HTMLSelectElement) {
        for (const option of field.options)
          option.defaultSelected = option.selected;
      } else if (
        field instanceof HTMLInputElement &&
        (field.type === "checkbox" || field.type === "radio")
      ) {
        field.defaultChecked = field.checked;
      } else {
        field.defaultValue = field.value;
      }
    }
    update();
  }, [formRef, update]);

  // Delegation also covers forms mounted later inside a modal's portal.
  useEffect(() => {
    const onEdit = (event: Event) => {
      if (
        event.target instanceof Node &&
        formRef.current?.contains(event.target)
      )
        update();
    };
    const onReset = (event: Event) => {
      if (event.target === formRef.current) {
        queueMicrotask(() => {
          if (!event.defaultPrevented) update();
        });
      }
    };
    document.addEventListener("input", onEdit, true);
    document.addEventListener("change", onEdit, true);
    document.addEventListener("reset", onReset, true);
    return () => {
      document.removeEventListener("input", onEdit, true);
      document.removeEventListener("change", onEdit, true);
      document.removeEventListener("reset", onReset, true);
    };
  }, [formRef, update]);

  useEffect(() => {
    if (previousForm.current !== formRef.current) {
      previousForm.current = formRef.current;
      update();
      if (!formRef.current)
        setDirtyNames((previous) => (previous.size ? new Set() : previous));
    }
  });

  return { dirtyNames, isDirty: dirtyNames.size > 0, reset };
}
