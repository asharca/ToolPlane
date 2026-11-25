"use client";

import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type RefObject,
} from "react";
import { AlertTriangle, ArrowDown, Upload } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Button } from "@/components/motion/button";
import {
  CenterMorphModal,
  CenterMorphModalContent,
} from "@/components/motion/center-morph-modal";
import {
  DialogBody,
  DialogCancel,
  DialogFooter,
  DialogHeader,
} from "@/components/dashboard/dialog";
import type { FileUIPart } from "ai";
import { apiRequest } from "@/lib/client/api";
import { DisplayError } from "@/components/dashboard/display-error";
import { STORAGE_QUOTA_EXCEEDED } from "@/components/dashboard/ManageFilesButton";
import { SPRING_PRESS } from "@/lib/ease";
import { cn } from "@/lib/utils";

/** Shared guard for global keyboard shortcuts so typing inside controls stays undisturbed. */
export function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable
  ) {
    return true;
  }
  return target.closest('[contenteditable="true"]') !== null;
}

/** Shared guard for global shortcuts while any modal or dialog popover is open. */
export function hasOpenDialog(): boolean {
  return (
    typeof document !== "undefined" &&
    document.querySelector('[role="dialog"]') !== null
  );
}

/** Floating scroll-to-bottom control anchored above a conversation composer dock. */
export function ScrollToBottomButton({
  visible,
  onClick,
  label,
  className,
}: {
  visible: boolean;
  onClick: () => void;
  label: string;
  className?: string;
}) {
  const reduce = useReducedMotion();
  return (
    <AnimatePresence>
      {visible ? (
        <motion.div
          key="scroll-to-bottom"
          initial={reduce ? { opacity: 1 } : { opacity: 0, y: 6, scale: 0.92 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.92 }}
          transition={reduce ? { duration: 0 } : SPRING_PRESS}
          className={cn(
            "pointer-events-none absolute -top-12 left-1/2 z-20 -translate-x-1/2",
            className,
          )}
        >
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={label}
            title={label}
            onClick={onClick}
            className="pointer-events-auto size-9 rounded-full border-border bg-background/95 shadow-md backdrop-blur-sm hover:bg-muted"
          >
            <ArrowDown className="size-4" aria-hidden="true" />
          </Button>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/** Accessible confirmation dialog replacing native window.confirm prompts. */
export function ConfirmActionDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  destructive = false,
  busy = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}) {
  return (
    <CenterMorphModal
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <CenterMorphModalContent
        ariaLabel={title}
        closeButtonLabel={cancelLabel}
        dismissible={!busy}
        className="flex max-h-[calc(100dvh-4rem)] w-full max-w-md flex-col"
      >
        <DialogHeader
          title={title}
          icon={
            destructive ? (
              <AlertTriangle
                className="size-4 shrink-0 text-destructive"
                aria-hidden="true"
              />
            ) : undefined
          }
        />
        <DialogBody>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        </DialogBody>
        <DialogFooter
          cancel={
            <DialogCancel disabled={busy} onClick={onClose}>
              {cancelLabel}
            </DialogCancel>
          }
        >
          <Button
            type="button"
            variant={destructive ? "secondary" : "primary"}
            size="md"
            disabled={busy}
            onClick={() => void onConfirm()}
            className={
              destructive
                ? "border-destructive/40 bg-destructive text-destructive-foreground hover:bg-destructive/90"
                : undefined
            }
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </CenterMorphModalContent>
    </CenterMorphModal>
  );
}

function hasFileDataTransfer(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  return Array.from(dataTransfer.types ?? []).includes("Files");
}

function clipboardFiles(clipboardData: DataTransfer | null): File[] {
  if (!clipboardData) return [];
  if (clipboardData.files?.length) return Array.from(clipboardData.files);
  const files: File[] = [];
  for (const item of Array.from(clipboardData.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

/** Drag-and-drop and clipboard paste attachment handlers for chat/work composers. */
export function useComposerFileDrop({
  enabled,
  onFiles,
}: {
  enabled: boolean;
  onFiles: (files: FileList | File[]) => void;
}) {
  const dragDepthRef = useRef(0);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!enabled) {
      dragDepthRef.current = 0;
      setDragging(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!dragging) return;
    const reset = () => {
      dragDepthRef.current = 0;
      setDragging(false);
    };
    window.addEventListener("dragend", reset);
    window.addEventListener("drop", reset);
    return () => {
      window.removeEventListener("dragend", reset);
      window.removeEventListener("drop", reset);
    };
  }, [dragging]);

  const dropProps = {
    onDragEnter: (event: DragEvent<HTMLElement>) => {
      if (!enabled || !hasFileDataTransfer(event.dataTransfer)) return;
      event.preventDefault();
      dragDepthRef.current += 1;
      setDragging(true);
    },
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!enabled || !hasFileDataTransfer(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (!enabled || !hasFileDataTransfer(event.dataTransfer)) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setDragging(false);
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      dragDepthRef.current = 0;
      setDragging(false);
      if (!enabled || !event.dataTransfer.files?.length) return;
      event.preventDefault();
      onFiles(event.dataTransfer.files);
    },
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!enabled) return;
    const files = clipboardFiles(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    onFiles(files);
  };

  return { dragging, dropProps, handlePaste };
}

/** Shared subtle overlay rendered while files are dragged over a composer or transcript. */
export function ComposerDropOverlay({
  dragging,
  label,
  className,
}: {
  dragging: boolean;
  label: string;
  className?: string;
}) {
  if (!dragging) return null;
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/60 bg-background/85 backdrop-blur-xs",
        className,
      )}
    >
      <div className="flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-foreground shadow-sm">
        <Upload className="size-4 text-primary" />
        <span>{label}</span>
      </div>
    </div>
  );
}

/** Focuses a list search input when pressing '/' outside inputs and dialogs. */
export function useSlashFocusSearch(
  inputRef: RefObject<HTMLInputElement | null>,
  enabled = true,
) {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "/" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        event.isComposing
      ) {
        return;
      }
      if (isEditableEventTarget(event.target) || hasOpenDialog()) return;
      const input = inputRef.current;
      if (!input || input.disabled) return;
      event.preventDefault();
      input.focus();
      input.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, inputRef]);
}

/** Shared attachment upload helper used across live and draft chat composers. */
export async function uploadWorkspaceAttachments({
  attachmentUploadUrl,
  selected,
  existingCount,
  limit = 5,
  limitReachedMessage,
  uploadFailedMessage,
}: {
  attachmentUploadUrl: string;
  selected: FileList | File[];
  existingCount: number;
  limit?: number;
  limitReachedMessage: string;
  uploadFailedMessage: string;
}): Promise<FileUIPart[]> {
  const list = Array.from(selected);
  if (list.length + existingCount > limit) {
    throw new DisplayError(limitReachedMessage);
  }
  const uploaded: FileUIPart[] = [];
  for (const file of list) {
    const url = new URL(attachmentUploadUrl, window.location.origin);
    url.searchParams.set("filename", file.name);
    const response = await apiRequest<{
      url?: string;
      name?: string;
      mimeType?: string;
    }>(`${url.pathname}${url.search}`, {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file,
    });
    if (!response.ok || !response.data?.url) {
      throw new DisplayError(
        !response.ok && response.code === STORAGE_QUOTA_EXCEEDED
          ? STORAGE_QUOTA_EXCEEDED
          : (!response.ok && response.message) || uploadFailedMessage,
      );
    }
    uploaded.push({
      type: "file",
      url: response.data.url,
      filename: response.data.name ?? file.name,
      mediaType: response.data.mimeType ?? file.type,
    });
  }
  return uploaded;
}
