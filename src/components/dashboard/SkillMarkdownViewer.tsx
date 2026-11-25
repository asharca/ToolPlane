"use client";
import { Button, ButtonLink } from "@/components/motion/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/motion/tabs";

import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import { Code2, Download, Eye } from "lucide-react";
import { code } from "@streamdown/code";
import { CopyButton } from "./CopyButton";
import { SafeStreamdown } from "./SafeStreamdown";
import { updateSkillContentAction } from "@/lib/skills/actions";

export function SkillMarkdownViewer({
  markdown,
  downloadHref,
  editable,
}: {
  markdown: string;
  downloadHref?: string;
  editable?: {
    workspace: string;
    installId: string;
    content: string;
  };
}) {
  const t = useTranslations("console.skills");
  const [mode, setMode] = useState<"rendered" | "source">("rendered");
  // Textareas normalize CRLF from multipart saves to LF; compare the same draft representation.
  const initialContent = (editable?.content ?? markdown).replace(
    /\r\n?/g,
    "\n",
  );
  const [content, setContent] = useState(initialContent);
  const [savedContent, setSavedContent] = useState(initialContent);
  const [state, formAction, isPending] = useActionState(
    async (
      previous: { error?: string; saved?: boolean },
      formData: FormData,
    ) => {
      const result = await updateSkillContentAction(previous, formData);
      if (result.saved) setSavedContent(String(formData.get("content") ?? ""));
      return result;
    },
    {},
  );
  const isDirty = content !== savedContent;
  const draft = editable ? content : markdown;
  const renderedMarkdown =
    draft.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, "").trim() || draft;

  return (
    <section className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-border px-5 py-4 lg:flex-row lg:items-center lg:justify-between sm:px-6">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            SKILL.md
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Tabs
            value={mode}
            onValueChange={(next) => setMode(next as "rendered" | "source")}
            variant="segment"
          >
            <TabsList>
              <TabsTrigger value="rendered" disabled={isPending}>
                <span className="inline-flex items-center gap-1.5">
                  <Eye className="size-3.5" />
                  {t("rendered")}
                </span>
              </TabsTrigger>
              <TabsTrigger value="source" disabled={isPending}>
                <span className="inline-flex items-center gap-1.5">
                  <Code2 className="size-3.5" />
                  {t(editable ? "editSource" : "sourceCode")}
                </span>
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <CopyButton text={draft} label={t("copy")} />
          {downloadHref ? (
            <>
              <ButtonLink href={downloadHref} variant="secondary" size="sm">
                <Download className="size-3.5" />
                {t("downloadSkillBundle")}
              </ButtonLink>
              <ButtonLink
                href={`${downloadHref}?format=markdown`}
                variant="ghost"
                size="sm"
              >
                <Download className="size-3.5" />
                {t("downloadSkillmd")}
              </ButtonLink>
            </>
          ) : null}
        </div>
      </div>
      {editable && (isPending || isDirty || state.saved) ? (
        <p role="status" className="px-5 pt-3 text-xs text-muted-foreground">
          {t(isPending ? "saving" : isDirty ? "unsaved" : "saved")}
        </p>
      ) : null}
      {state.error ? (
        <p role="alert" className="px-5 pt-3 text-sm text-destructive">
          {state.error}
        </p>
      ) : null}

      {mode === "rendered" ? (
        <div className="prose prose-sm max-w-none bg-card p-5 leading-7 dark:prose-invert sm:p-6">
          <SafeStreamdown
            mode="static"
            plugins={{ code }}
            components={{
              h1: ({ children }) => <h3>{children}</h3>,
            }}
          >
            {renderedMarkdown}
          </SafeStreamdown>
        </div>
      ) : editable ? (
        <form
          action={formAction}
          className="space-y-3 bg-background p-5 sm:p-6"
        >
          <input type="hidden" name="workspace" value={editable.workspace} />
          <input type="hidden" name="installId" value={editable.installId} />
          <textarea
            name="content"
            aria-label={t("editSource")}
            disabled={isPending}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            rows={24}
            className="min-h-[28rem] w-full resize-y rounded-lg bg-muted/35 p-3 font-mono text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button
            variant="primary"
            size="md"
            type="submit"
            disabled={isPending}
          >
            {t(isPending ? "saving" : "saveSource")}
          </Button>
        </form>
      ) : (
        <pre className="max-h-[34rem] overflow-auto bg-background p-5 font-mono text-xs leading-6 text-foreground sm:p-6">
          {markdown}
        </pre>
      )}
    </section>
  );
}
