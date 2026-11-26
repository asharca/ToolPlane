"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Camera, Flag, Info, Send, Terminal, Trash2 } from "lucide-react";
import { apiRequest } from "@/lib/client/api";
import { displayErrorText } from "@/components/dashboard/display-error";
import { notify } from "@/components/dashboard/Toaster";
import { consumeStoredErrorFeedbackCapture } from "@/lib/feedback/error-capture";
import {
  FEEDBACK_CATEGORIES,
  type FeedbackCategory,
  type FeedbackDiagnosticContext,
  type FeedbackDiagnosticLogItem,
  type FeedbackStatus,
  type FeedbackSummaryItem,
} from "@/lib/feedback/types";
import {
  AnimatedBadge,
  type AnimatedBadgeStatus,
} from "@/components/motion/animated-badge";
import { Button } from "@/components/motion/button";
import {
  CenterMorphModal,
  CenterMorphModalContent,
} from "@/components/motion/center-morph-modal";
import { Input } from "@/components/motion/input";
import { DialogHeader } from "@/components/dashboard/dialog";
import { FormSelect } from "@/components/ui/FormSelect";

type FeedbackPrefill = {
  category: FeedbackCategory;
  failureCode?: string;
  workSessionId?: string;
  taskId?: string;
  conversationId?: string;
  agentId?: string;
};

function statusTone(status: FeedbackStatus): AnimatedBadgeStatus {
  switch (status) {
    case "open":
      return "warning";
    case "acknowledged":
      return "info";
    case "resolved":
      return "success";
    case "dismissed":
      return "neutral";
  }
}

function logBadgeTone(
  level: FeedbackDiagnosticLogItem["level"],
): AnimatedBadgeStatus {
  if (level === "error") return "danger";
  if (level === "warn") return "warning";
  return "neutral";
}

function DiagnosticLogList({
  logs,
  format,
}: {
  logs: FeedbackDiagnosticLogItem[];
  format: ReturnType<typeof useFormatter>;
}) {
  return (
    <ul className="max-h-56 space-y-2 overflow-y-auto overscroll-contain pr-1 text-xs">
      {logs.map((entry, index) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: Diagnostic logs are ordered immutable records.
          key={index}
          className="rounded-lg border border-border/70 bg-background/80 px-3 py-2"
        >
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            <AnimatedBadge
              status={logBadgeTone(entry.level)}
              size="sm"
              showIcon={false}
            >
              {entry.level.toUpperCase()}
            </AnimatedBadge>
            <span className="font-mono text-foreground">{entry.source}</span>
            {entry.code ? (
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground">
                {entry.code}
              </span>
            ) : null}
            {entry.stage ? (
              <span className="font-mono text-[10px]">{entry.stage}</span>
            ) : null}
            {entry.occurredAt ? (
              <span className="ml-auto tabular-nums">
                {format.dateTime(new Date(entry.occurredAt), {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}
              </span>
            ) : null}
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground">
            {entry.message}
          </p>
        </li>
      ))}
    </ul>
  );
}

export function FeedbackClient({
  workspaceId,
  workspaceSlug,
  initialPrefill,
  initialDiagnostics = null,
  captured = false,
}: {
  workspaceId: string;
  workspaceSlug: string;
  initialPrefill: FeedbackPrefill;
  initialDiagnostics?: FeedbackDiagnosticContext | null;
  captured?: boolean;
}) {
  const t = useTranslations("console.feedback");
  const common = useTranslations("common");
  const format = useFormatter();

  const [category, setCategory] = useState<FeedbackCategory>(
    initialPrefill.category,
  );
  const [title, setTitle] = useState(
    initialPrefill.failureCode
      ? t("prefillFailureTitle", { code: initialPrefill.failureCode })
      : "",
  );
  const [body, setBody] = useState(() => {
    if (!captured) return "";
    if (initialDiagnostics?.failureReason) {
      return t("prefillFailureBody", {
        error: initialDiagnostics.failureReason,
      });
    }
    if (initialPrefill.failureCode) {
      return t("prefillFailureCodeBody", { code: initialPrefill.failureCode });
    }
    return "";
  });
  const [screenshotDataUrl, setScreenshotDataUrl] = useState<string | null>(
    null,
  );
  const [capturedErrorText, setCapturedErrorText] = useState("");
  const [includeDiagnosticLogs, setIncludeDiagnosticLogs] = useState(
    Boolean(initialDiagnostics?.diagnosticLogs.length) || captured,
  );
  const [includeSnippet, setIncludeSnippet] = useState(
    Boolean(initialPrefill.conversationId),
  );
  const [snippetMessageCount, setSnippetMessageCount] = useState(6);
  const [submitting, setSubmitting] = useState(false);
  const [previewImageSrc, setPreviewImageSrc] = useState<string | null>(null);

  const [items, setItems] = useState<FeedbackSummaryItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const capture = consumeStoredErrorFeedbackCapture(workspaceSlug);
    if (!capture) return;
    if (capture.screenshotDataUrl) {
      setScreenshotDataUrl(capture.screenshotDataUrl);
    }
    if (capture.errorText) {
      setCapturedErrorText(capture.errorText);
      setIncludeDiagnosticLogs(true);
      setBody((current) =>
        current.trim()
          ? current
          : t("prefillFailureBody", { error: capture.errorText }),
      );
    }
  }, [t, workspaceSlug]);

  const previewLogs = useMemo<FeedbackDiagnosticLogItem[]>(() => {
    const serverLogs = initialDiagnostics?.diagnosticLogs ?? [];
    if (!capturedErrorText) return serverLogs;
    if (serverLogs.some((entry) => entry.message === capturedErrorText)) {
      return serverLogs;
    }
    return [
      {
        level: "error",
        source: "ui",
        code: initialPrefill.failureCode ?? null,
        stage: initialDiagnostics?.executionStage ?? null,
        message: capturedErrorText,
      },
      ...serverLogs,
    ];
  }, [
    capturedErrorText,
    initialDiagnostics?.diagnosticLogs,
    initialDiagnostics?.executionStage,
    initialPrefill.failureCode,
  ]);

  const loadFeedback = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiRequest<{ items: FeedbackSummaryItem[] }>(
        "/api/v1/feedback",
      );
      if (res.ok && Array.isArray(res.data.items)) {
        setItems(res.data.items);
      } else {
        notify(t("loadFailed"), { severity: "error" });
      }
    } catch {
      notify(t("loadFailed"), { severity: "error" });
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadFeedback();
  }, [loadFeedback]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedTitle = title.trim();
    const trimmedBody = body.trim();
    if (!trimmedTitle || !trimmedBody) {
      notify(t("validationRequired"), { severity: "error" });
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiRequest("/api/v1/feedback", {
        method: "POST",
        body: JSON.stringify({
          category,
          title: trimmedTitle,
          body: trimmedBody,
          workspaceId,
          ...(initialPrefill.agentId
            ? { agentId: initialPrefill.agentId }
            : {}),
          ...(initialPrefill.conversationId
            ? { conversationId: initialPrefill.conversationId }
            : {}),
          ...(initialPrefill.taskId ? { taskId: initialPrefill.taskId } : {}),
          ...(initialPrefill.workSessionId
            ? { workSessionId: initialPrefill.workSessionId }
            : {}),
          ...(initialPrefill.failureCode
            ? { failureCode: initialPrefill.failureCode }
            : {}),
          ...(initialPrefill.conversationId && includeSnippet
            ? {
                includeConversationSnippet: true,
                snippetMessageCount,
              }
            : {}),
          ...(screenshotDataUrl ? { screenshotDataUrl } : {}),
          ...(previewLogs.length > 0
            ? {
                includeDiagnosticLogs,
                ...(capturedErrorText && includeDiagnosticLogs
                  ? { clientErrorText: capturedErrorText }
                  : {}),
              }
            : {}),
        }),
      });
      if (!res.ok) {
        notify(res.message || t("submitFailed"), { severity: "error" });
        return;
      }
      notify(t("submitSuccess"), { severity: "info" });
      setTitle("");
      setBody("");
      setScreenshotDataUrl(null);
      setCapturedErrorText("");
      await loadFeedback();
    } catch (error) {
      notify(displayErrorText(error, t("submitFailed")), {
        severity: "error",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-8">
      <section className="rounded-xl border border-border bg-card p-6">
        <div className="mb-5 space-y-1">
          <h2 className="text-base font-semibold text-foreground">
            {t("submitTitle")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("submitDescription")}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <label
                htmlFor="feedback-category"
                className="text-xs font-medium text-foreground"
              >
                {t("categoryLabel")}
              </label>
              <FormSelect
                id="feedback-category"
                name="category"
                value={category}
                onValueChange={(value) =>
                  setCategory(value as FeedbackCategory)
                }
                label={t("categoryLabel")}
                options={FEEDBACK_CATEGORIES.map((cat) => ({
                  value: cat,
                  label: t(`categories.${cat}`),
                }))}
              />
            </div>

            <div className="space-y-1.5 sm:col-span-2">
              <label
                htmlFor="feedback-title"
                className="text-xs font-medium text-foreground"
              >
                {t("titleLabel")}
              </label>
              <Input
                id="feedback-title"
                type="text"
                value={title}
                onChange={setTitle}
                maxLength={200}
                required
                placeholder={t("titlePlaceholder")}
                className="w-full"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="feedback-body"
              className="text-xs font-medium text-foreground"
            >
              {t("bodyLabel")}
            </label>
            <textarea
              id="feedback-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={4000}
              rows={5}
              required
              placeholder={t("bodyPlaceholder")}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          {screenshotDataUrl ? (
            <div className="space-y-2.5 rounded-xl border border-border bg-muted/30 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                  <Camera className="size-4 text-muted-foreground" />
                  <span>{t("capturedScreenshotTitle")}</span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setScreenshotDataUrl(null)}
                  className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="size-3.5" />
                  <span>{t("removeScreenshot")}</span>
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("capturedScreenshotHint")}
              </p>
              <button
                type="button"
                onClick={() => setPreviewImageSrc(screenshotDataUrl)}
                className="block overflow-hidden rounded-lg border border-border bg-background transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {/* biome-ignore lint/performance/noImgElement: Inline base64 data URL screenshot cannot use next/image optimizer. */}
                <img
                  src={screenshotDataUrl}
                  alt={t("screenshotAlt")}
                  className="max-h-56 w-auto object-contain"
                />
              </button>
            </div>
          ) : null}

          {previewLogs.length > 0 ? (
            <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                  <Terminal className="size-4 text-muted-foreground" />
                  <span>
                    {t("diagnosticLogsTitle", { count: previewLogs.length })}
                  </span>
                </div>
                <label className="flex items-center gap-2 text-xs text-foreground">
                  <input
                    type="checkbox"
                    checked={includeDiagnosticLogs}
                    onChange={(e) => setIncludeDiagnosticLogs(e.target.checked)}
                    className="size-4 rounded border-border"
                  />
                  <span>{t("includeDiagnosticLogsLabel")}</span>
                </label>
              </div>
              {includeDiagnosticLogs ? (
                <DiagnosticLogList logs={previewLogs} format={format} />
              ) : null}
            </div>
          ) : null}

          {initialPrefill.conversationId ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-muted/30 px-4 py-3 text-sm">
              <label className="flex items-center gap-2.5 text-foreground">
                <input
                  type="checkbox"
                  checked={includeSnippet}
                  onChange={(e) => setIncludeSnippet(e.target.checked)}
                  className="size-4 rounded border-border"
                />
                <span>{t("attachSnippetLabel")}</span>
              </label>
              {includeSnippet ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <label htmlFor="snippet-count">
                    {t("snippetCountLabel")}
                  </label>
                  <FormSelect
                    id="snippet-count"
                    label={t("snippetCountLabel")}
                    value={String(snippetMessageCount)}
                    onValueChange={(value) =>
                      setSnippetMessageCount(Number(value))
                    }
                    className="w-20"
                    options={[2, 4, 6, 8, 10].map((count) => ({
                      value: String(count),
                      label: String(count),
                    }))}
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="flex items-start gap-2 rounded-xl border border-border/80 bg-muted/30 px-3.5 py-2.5 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span>{t("adminVisibilityNotice")}</span>
          </div>

          <div className="flex justify-end">
            <Button type="submit" disabled={submitting}>
              <Send className="mr-1.5 size-4" />
              {submitting ? t("submitting") : t("submitButton")}
            </Button>
          </div>
        </form>
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-foreground">
            {t("myFeedbackTitle")}
          </h2>
          <span className="text-xs text-muted-foreground">
            {t("itemCount", { count: items.length })}
          </span>
        </div>

        {loading ? (
          <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
            {t("loading")}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/50 px-6 py-12 text-center">
            <Flag className="mb-3 size-8 text-muted-foreground/60" />
            <p className="text-sm font-medium text-foreground">
              {t("emptyTitle")}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("emptyDescription")}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {items.map((item) => (
              <article
                key={item.id}
                className="rounded-xl border border-border bg-card p-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <h3 className="text-sm font-semibold text-foreground break-words">
                      {item.title}
                    </h3>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <AnimatedBadge
                        status={statusTone(item.status)}
                        size="sm"
                        showIcon
                      >
                        {t(`statuses.${item.status}`)}
                      </AnimatedBadge>
                      <AnimatedBadge status="neutral" size="sm">
                        {t(`categories.${item.category}`)}
                      </AnimatedBadge>
                      <AnimatedBadge status="neutral" size="sm">
                        {t(`sources.${item.source}`)}
                      </AnimatedBadge>
                      <span>
                        {format.dateTime(new Date(item.createdAt), {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                  </div>
                </div>

                {item.body ? (
                  <p className="mt-3 whitespace-pre-wrap break-words text-sm text-muted-foreground">
                    {item.body}
                  </p>
                ) : null}

                {item.screenshotDataUrl ? (
                  <div className="mt-3">
                    <button
                      type="button"
                      onClick={() => setPreviewImageSrc(item.screenshotDataUrl)}
                      className="overflow-hidden rounded-lg border border-border bg-background transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {/* biome-ignore lint/performance/noImgElement: Inline base64 data URL screenshot cannot use next/image optimizer. */}
                      <img
                        src={item.screenshotDataUrl}
                        alt={t("screenshotAlt")}
                        className="max-h-36 w-auto object-contain"
                      />
                    </button>
                  </div>
                ) : null}

                {item.diagnosticLogs && item.diagnosticLogs.length > 0 ? (
                  <details className="mt-3 rounded-xl border border-border/80 bg-muted/30 px-3.5 py-2.5 text-xs">
                    <summary className="cursor-pointer font-medium text-foreground">
                      {t("diagnosticLogCount", {
                        count: item.diagnosticLogs.length,
                      })}
                    </summary>
                    <div className="mt-2">
                      <DiagnosticLogList
                        logs={item.diagnosticLogs}
                        format={format}
                      />
                    </div>
                  </details>
                ) : null}

                {item.adminNote ? (
                  <div className="mt-3 rounded-xl border border-border/80 bg-muted/40 px-3.5 py-2.5 text-xs">
                    <span className="font-medium text-foreground">
                      {t("adminNoteLabel")}:{" "}
                    </span>
                    <span className="whitespace-pre-wrap break-words text-muted-foreground">
                      {item.adminNote}
                    </span>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </section>

      <CenterMorphModal
        open={Boolean(previewImageSrc)}
        onOpenChange={(open) => {
          if (!open) setPreviewImageSrc(null);
        }}
      >
        <CenterMorphModalContent
          ariaLabel={t("screenshotAlt")}
          closeButtonLabel={common("close")}
          className="flex max-h-[calc(100dvh-2rem)] w-full max-w-4xl flex-col overflow-hidden"
        >
          <DialogHeader
            title={t("screenshotAlt")}
            className="border-b border-border"
          />
          <div className="min-h-0 flex-1 overflow-auto p-4">
            {previewImageSrc ? (
              /* biome-ignore lint/performance/noImgElement: Inline base64 data URL screenshot cannot use next/image optimizer. */
              <img
                src={previewImageSrc}
                alt={t("screenshotAlt")}
                className="mx-auto max-h-[75dvh] w-auto rounded-lg border border-border object-contain"
              />
            ) : null}
          </div>
        </CenterMorphModalContent>
      </CenterMorphModal>
    </div>
  );
}
