import { expect, it } from "vitest";
import { isNativeFieldDirty } from "@/lib/forms/dirty-fields";

it("compares text, checkbox and multiple selection with their saved defaults", () => {
  const text = document.createElement("input");
  text.defaultValue = "Saved name";
  expect(isNativeFieldDirty(text)).toBe(false);
  text.value = "Changed name";
  expect(isNativeFieldDirty(text)).toBe(true);
  text.value = "Saved name";
  expect(isNativeFieldDirty(text)).toBe(false);

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.defaultChecked = true;
  expect(isNativeFieldDirty(checkbox)).toBe(false);
  checkbox.checked = false;
  expect(isNativeFieldDirty(checkbox)).toBe(true);
  checkbox.checked = true;
  expect(isNativeFieldDirty(checkbox)).toBe(false);

  const select = document.createElement("select");
  select.multiple = true;
  select.innerHTML =
    '<option value="a" selected>A</option><option value="b">B</option><option value="c" selected>C</option>';
  expect(isNativeFieldDirty(select)).toBe(false);
  select.options[1].selected = true;
  expect(isNativeFieldDirty(select)).toBe(true);
  select.options[1].selected = false;
  expect(isNativeFieldDirty(select)).toBe(false);
  for (const option of select.options) option.defaultSelected = false;
  expect(isNativeFieldDirty(select)).toBe(false);
  select.options[0].selected = true;
  expect(isNativeFieldDirty(select)).toBe(true);
});
