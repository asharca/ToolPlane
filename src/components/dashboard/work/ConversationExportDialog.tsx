"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/motion/button";
import { notify } from "@/components/dashboard/Toaster";
import {
  CenterMorphModal,
  CenterMorphModalContent,
} from "@/components/motion/center-morph-modal";
import { DialogHeader, DialogBody } from "@/components/dashboard/dialog";
import type { SessionExportFailureCode } from "@/lib/agents/conversation-export";

export type ConversationExportTarget = {
  id: string;
  agentId: string;
  nativeAvailable: boolean;
};
type ConversationExportFormat = "jsonl" | "html" | "md";

// Every server failure code has its own translated text.
const exportErrorKeys: Record<SessionExportFailureCode, string> = {
  UNAUTHORIZED: "exportUnauthorized",
  NOT_FOUND: "exportNotFound",
  SESSION_EXPORT_FORMAT_INVALID: "exportFormatInvalid",
  SESSION_EXPORT_NATIVE_UNAVAILABLE: "exportNativeUnavailable",
  SESSION_EXPORT_SANDBOX_NOT_RUNNING: "exportSandboxNotRunning",
  SESSION_EXPORT_SANDBOX_BUSY: "exportSandboxBusy",
  SESSION_EXPORT_NATIVE_MISSING: "exportNativeMissing",
  SESSION_EXPORT_NATIVE_INVALID: "exportNativeInvalid",
  SESSION_EXPORT_TOO_LARGE: "exportTooLarge",
  SESSION_EXPORT_FAILED: "exportFailed",
};

function exportFilename(disposition: string, fallback: string) {
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  if (utf8) {
    try {
      return decodeURIComponent(utf8.trim()).replace(/[\\/]/g, "-") || fallback;
    } catch {
      // A malformed extended filename must not discard a valid download.
    }
  }
  return /filename="([^"]+)"/i.exec(disposition)?.[1] ?? fallback;
}

/** A file download, not a JSON call: the success body is the attachment itself. */
export function ConversationExportDialog({
  target,
  onClose,
}: {
  target: ConversationExportTarget | null;
  onClose: () => void;
}) {
  const t = useTranslations("console.work");
  const common = useTranslations("common");
  const [pending, setPending] = useState<ConversationExportFormat | null>(null);
  const [nativeUnavailable, setNativeUnavailable] = useState(false);
  const inFlight = useRef(false);

  async function download(format: ConversationExportFormat) {
    if (!target || inFlight.current) return;
    inFlight.current = true;
    setPending(format);
    try {
      const response = await fetch(
        `/api/v1/agents/${encodeURIComponent(target.agentId)}/conversations/${encodeURIComponent(target.id)}/export?format=${format}`,
        { credentials: "same-origin", cache: "no-store" },
      );
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const code =
          body && typeof body === "object" && "code" in body ? body.code : null;
        const key =
          typeof code === "string" && Object.hasOwn(exportErrorKeys, code)
            ? exportErrorKeys[code as SessionExportFailureCode]
            : response.status === 401
              ? "exportUnauthorized"
              : response.status === 404
                ? "exportNotFound"
                : response.status === 413
                  ? "exportTooLarge"
                  : "exportFailed";
        if (code === "SESSION_EXPORT_NATIVE_UNAVAILABLE")
          setNativeUnavailable(true);
        notify(t(key), { severity: "error" });
        return;
      }
      const contentType = response.headers
        .get("content-type")
        ?.split(";", 1)[0];
      const expectedType = {
        jsonl: "application/x-ndjson",
        html: "text/html",
        md: "text/markdown",
      }[format];
      const disposition = response.headers.get("content-disposition") ?? "";
      if (contentType !== expectedType || !/^attachment\b/i.test(disposition)) {
        notify(t("exportFailed"), { severity: "error" });
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      try {
        anchor.href = url;
        anchor.download = exportFilename(
          disposition,
          `conversation-${target.id}.${format}`,
        );
        document.body.append(anchor);
        anchor.click();
      } finally {
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      onClose();
    } catch {
      notify(t("exportFailed"), { severity: "error" });
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }

  const formats: ConversationExportFormat[] =
    target?.nativeAvailable && !nativeUnavailable
      ? ["jsonl", "html", "md"]
      : ["md"];
  const labels = {
    jsonl: "exportJsonl",
    html: "exportHtml",
    md: "exportMarkdown",
  } as const;
  return (
    <CenterMorphModal
      open={Boolean(target)}
      onOpenChange={(open) => {
        if (!open && !inFlight.current) onClose();
      }}
    >
      <CenterMorphModalContent
        ariaLabel={t("exportConversation")}
        closeButtonLabel={common("cancel")}
        className="max-w-md"
      >
        <DialogHeader title={t("exportConversation")} />
        <DialogBody>
          <div className="flex flex-wrap gap-2" aria-busy={Boolean(pending)}>
            {formats.map((format) => (
              <Button
                key={format}
                type="button"
                variant="outline"
                size="md"
                disabled={Boolean(pending)}
                onClick={() => void download(format)}
              >
                {pending === format
                  ? t("exportDownloading")
                  : t(labels[format])}
              </Button>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            {t("exportPersistedOnly")}
          </p>
        </DialogBody>
      </CenterMorphModalContent>
    </CenterMorphModal>
  );
}
