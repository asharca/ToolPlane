"use client";

import { useRef, useState } from "react";
import { Loader2, RotateCcw, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { AssistantMarkdown } from "@/components/dashboard/ConversationMessage";
import { Button } from "@/components/motion/button/base";
import { Tabs, TabsList, TabsTrigger } from "@/components/motion/tabs";
import { estimatePromptTokens } from "@/lib/prompt-tokens";
import { cn } from "@/lib/utils";

type Mode = "edit" | "preview";

/**
 * Agent and Assistant instructions editor. It fills the remaining height of its
 * flex column parent; the text area scrolls instead of being resized by hand.
 */
export function SystemPromptEditor({
  workspaceId,
  name,
  description,
  providerId,
  model,
  value,
  onChange,
  maxLength,
  placeholder,
  dirty,
  fieldName = "systemPrompt",
  className,
}: {
  workspaceId: string;
  name: string;
  description?: string;
  providerId: string;
  model: string;
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  placeholder: string;
  dirty?: boolean;
  fieldName?: string;
  className?: string;
}) {
  const t = useTranslations("console.agents");
  const common = useTranslations("common");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [mode, setMode] = useState<Mode>(value.trim() ? "preview" : "edit");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restore, setRestore] = useState<{
    previous: string;
    generated: string;
  } | null>(null);
  const canGenerate = Boolean(
    workspaceId && name.trim() && providerId && model,
  );

  function edit() {
    setMode("edit");
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  async function generate() {
    if (!canGenerate || generating) return;
    setGenerating(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/chat/assistants/generate-prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          name: name.trim(),
          description: description?.trim() || null,
          systemPrompt: value.trim() || null,
          modelProviderId: providerId,
          model,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        prompt?: string;
        error?: string;
      };
      if (!response.ok || !body.prompt?.trim())
        throw new Error(body.error || t("promptGenerationError"));
      const generated = body.prompt.trim();
      setRestore({ previous: value, generated });
      onChange(generated);
      setMode("edit");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("promptGenerationError"),
      );
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div
      data-dirty={dirty ? "true" : undefined}
      className={cn(
        "flex min-h-64 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background transition-colors has-[textarea:focus-visible]:border-ring data-[dirty=true]:border-primary/50",
        className,
      )}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-2 py-1.5">
        <Tabs
          variant="segment"
          value={mode}
          onValueChange={(next) =>
            next === "edit" ? edit() : setMode("preview")
          }
        >
          <TabsList aria-label={t("systemPrompt")} className="bg-muted/60">
            <TabsTrigger value="edit" className="px-3 py-1 text-xs">
              {common("edit")}
            </TabsTrigger>
            <TabsTrigger value="preview" className="px-3 py-1 text-xs">
              {common("preview")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {dirty ? (
          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
            {common("modified")}
          </span>
        ) : null}
        <span
          aria-live="polite"
          className="ml-auto px-1 text-xs tabular-nums text-muted-foreground"
        >
          {t("estimatedTokens", { count: estimatePromptTokens(value) })}
        </span>
        {restore?.generated === value ? (
          <Button
            type="button"
            onClick={() => {
              onChange(restore.previous);
              setRestore(null);
            }}
            aria-label={t("restorePreviousPrompt")}
            title={t("restorePreviousPrompt")}
            variant="ghost"
            size="icon"
          >
            <RotateCcw className="size-3.5" />
          </Button>
        ) : null}
        <Button
          type="button"
          disabled={!canGenerate || generating}
          onClick={() => void generate()}
          variant="secondary"
          size="sm"
          className="gap-1.5"
        >
          {generating ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Sparkles className="size-3.5" />
          )}
          {value.trim() ? t("improvePrompt") : t("generatePrompt")}
        </Button>
      </div>

      {mode === "preview" ? (
        <>
          <input type="hidden" name={fieldName} value={value} />
          <section
            aria-label={t("previewSystemPrompt")}
            className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-sm leading-7"
          >
            {value.trim() ? (
              <AssistantMarkdown text={value} />
            ) : (
              <p className="text-muted-foreground">{placeholder}</p>
            )}
          </section>
        </>
      ) : (
        <textarea
          ref={textareaRef}
          name={fieldName}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          maxLength={maxLength}
          placeholder={placeholder}
          aria-label={t("systemPrompt")}
          className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 text-sm leading-7 text-foreground outline-none placeholder:text-muted-foreground/60"
        />
      )}

      {error ? (
        <p
          role="alert"
          className="shrink-0 border-t border-border px-4 py-2 text-xs text-destructive"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
