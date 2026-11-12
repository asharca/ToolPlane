"use client";

import { useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { MessageSquare, ThumbsDown, ThumbsUp } from "lucide-react";
import { Button } from "@/components/motion/button";
import type { FeedbackDto } from "@/lib/agents/evolution/contracts";
import { evolutionRequest } from "./evolution-client";
import { notify } from "../Toaster";

export function AgentMessageFeedback({
  agentId,
  conversationId,
  messageId,
}: {
  agentId: string;
  conversationId: string;
  messageId: string;
}) {
  const t = useTranslations("console.evolution");
  const id = useId();
  const url = `/api/v1/agents/${encodeURIComponent(agentId)}/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/feedback`;
  const [feedback, setFeedback] = useState<FeedbackDto | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(false);
    setFeedback(null);
    setError("");
    evolutionRequest<FeedbackDto | null>(
      url,
      "GET",
      undefined,
      controller.signal,
    )
      .then((value) => {
        setFeedback(value);
        setComment(value?.comment ?? "");
        setLoaded(true);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "EVOLUTION_FAILED");
      });
    return () => controller.abort();
  }, [url]);
  async function save(rating: FeedbackDto["rating"] | null) {
    setBusy(true);
    setError("");
    try {
      const saved = await evolutionRequest<FeedbackDto | null>(url, "PUT", {
        rating,
        comment,
      });
      setFeedback(saved);
      setComment(saved?.comment ?? "");
      setOpen(false);
      notify(t("feedbackSaved"));
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "EVOLUTION_FAILED";
      setError(code);
      notify(
        t.has(`errors.${code}`)
          ? t(`errors.${code}`)
          : t("errors.EVOLUTION_FAILED"),
        { severity: "error" },
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-1"
      aria-busy={busy}
    >
      {(["positive", "negative"] as const).map((rating) => (
        <Button
          key={rating}
          type="button"
          variant="ghost"
          size="icon"
          className={`size-7 ${feedback?.rating === rating ? "bg-primary/10 text-primary" : ""}`}
          aria-label={t(rating)}
          aria-pressed={feedback?.rating === rating}
          disabled={!loaded || busy}
          onClick={() => void save(feedback?.rating === rating ? null : rating)}
        >
          {rating === "positive" ? (
            <ThumbsUp className="size-3.5" />
          ) : (
            <ThumbsDown className="size-3.5" />
          )}
        </Button>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label={t("comment")}
        aria-expanded={open}
        aria-controls={id}
        disabled={!loaded || busy}
        onClick={() => setOpen(!open)}
      >
        <MessageSquare className="size-3.5" />
      </Button>
      {open ? (
        <form
          id={id}
          className="flex w-full flex-wrap items-end gap-2 p-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (feedback) void save(feedback.rating);
          }}
        >
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
            {t("comment")}
            <textarea
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              maxLength={10000}
              rows={3}
              className="w-full rounded-lg border border-border bg-background p-2"
            />
          </label>
          <Button type="submit" size="sm" disabled={!feedback || busy}>
            {t("save")}
          </Button>
          {!feedback ? (
            <p className="w-full text-xs text-muted-foreground">
              {t("ratingFirst")}
            </p>
          ) : null}
        </form>
      ) : null}
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {t.has(`errors.${error}`)
            ? t(`errors.${error}`)
            : t("errors.EVOLUTION_FAILED")}
        </span>
      ) : null}
    </div>
  );
}
