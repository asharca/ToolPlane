/**
 * Compose modal content with DialogHeader, a scrollable DialogBody, and
 * DialogFooter cancel={<DialogCancel />}; primary actions follow Cancel.
 * Wrap named native controls in DialogField and call useDirtyFields(formRef).
 * After a successful save call reset(); for controlled/custom controls (including
 * motion Input), compare saved state explicitly with DialogField's dirty prop.
 * Use DialogNav for multi-section dialogs and pass each section's dirty state.
 */
"use client";

export {
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogCancel,
  DialogNav,
  DialogField,
} from "./DialogParts";
export type { DialogNavItem } from "./DialogParts";
export { useDirtyFields } from "./useDirtyFields";
