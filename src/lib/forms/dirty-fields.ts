export type NativeFormField =
  | HTMLInputElement
  | HTMLTextAreaElement
  | HTMLSelectElement;

/** Read-only comparison against the browser's saved form defaults. */
export function isNativeFieldDirty(field: NativeFormField): boolean {
  if (field instanceof HTMLInputElement) {
    if (field.type === "hidden" || field.readOnly) return false;
    return field.type === "checkbox" || field.type === "radio"
      ? field.checked !== field.defaultChecked
      : field.value !== field.defaultValue;
  }
  if (field instanceof HTMLTextAreaElement) {
    return !field.readOnly && field.value !== field.defaultValue;
  }
  const defaults = Array.from(field.options).filter(
    (option) => option.defaultSelected,
  );
  const expected = defaults.length
    ? defaults.map((option) => option.value)
    : !field.multiple && field.options.length
      ? [field.options[0].value]
      : [];
  const selected = Array.from(field.selectedOptions);
  return (
    selected.length !== expected.length ||
    selected.some((option, index) => option.value !== expected[index])
  );
}
