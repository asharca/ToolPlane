"use client";

import { Button } from "@/components/motion/button";
import { Input } from "@/components/motion/input";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Check, Loader2, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import {
  CenterMorphModal,
  CenterMorphModalClose,
  CenterMorphModalContent,
} from "@/components/motion/center-morph-modal";

type Prompt = { id: string; title: string; content: string };

export function ComposerPromptManager({
  agentId,
  onClose,
  onInsert,
}: {
  agentId: string;
  onClose: () => void;
  onInsert: (text: string) => void;
}) {
  const t = useTranslations("console.workComposer");
  const common = useTranslations("common");
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Partial<Prompt> | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const endpoint = `/api/v1/agents/${encodeURIComponent(agentId)}/composer-prompts`;
  const loadFailed = t("loadFailed");
  useEffect(() => {
    const controller = new AbortController();
    void fetch(endpoint, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(loadFailed);
        const data = await response.json();
        if (!controller.signal.aborted) setPrompts(data.prompts);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(loadFailed);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [endpoint, loadFailed]);

  async function mutate(body: Record<string, unknown>) {
    setSaving(true);
    setError("");
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(t("saveFailed"));
      const listed = await fetch(endpoint, { cache: "no-store" });
      if (!listed.ok) throw new Error(t("loadFailed"));
      setPrompts((await listed.json()).prompts);
      setEditing(null);
      setDeleting(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <CenterMorphModal
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <CenterMorphModalContent
        ariaLabel={t("prompts")}
        closeButtonLabel={common("close")}
        showCloseButton={!saving}
        dismissible={!saving}
        className="flex max-h-[calc(100dvh-2rem)] max-w-2xl flex-col gap-3"
      >
        <header className="flex min-h-16 items-center gap-3 pl-5 pr-16">
          <h2 className="text-lg font-semibold">{t("prompts")}</h2>
        </header>
        {editing ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void mutate({ action: "save", ...editing });
            }}
            className="min-h-0 space-y-3 overflow-y-auto"
          >
            <div className="block text-xs font-medium">
              {t("promptTitle")}
              <Input
                autoFocus
                required
                disabled={saving}
                maxLength={120}
                value={String(editing.title ?? "")}
                label={t("promptTitle")}
                onChange={(value) => setEditing({ ...editing, title: value })}
                className="mt-1 w-full"
              />
            </div>
            <label className="block text-xs font-medium">
              {t("promptContent")}
              <textarea
                aria-label={t("promptContent")}
                required
                disabled={saving}
                maxLength={20_000}
                rows={8}
                className="min-h-36 w-full resize-y rounded-lg bg-muted/35 p-3 text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={editing.content ?? ""}
                onChange={(event) =>
                  setEditing({ ...editing, content: event.target.value })
                }
              />
            </label>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                disabled={saving}
                onClick={() => setEditing(null)}
                variant={"secondary"}
                size={"sm"}
              >
                {common("cancel")}
              </Button>
              <Button
                type="submit"
                disabled={saving}
                variant={"primary"}
                size={"sm"}
              >
                {saving ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Check className="size-4" />
                )}
                {common("save")}
              </Button>
            </div>
          </form>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Input
                  leftIcon={<Search className="size-4" />}
                  aria-label={t("searchPrompts")}
                  placeholder={t("searchPrompts")}
                  value={String(query)}
                  onChange={(value) => setQuery(value)}
                  className="w-full"
                />
              </div>
              <Button
                type="button"
                aria-label={t("addPrompt")}
                title={t("addPrompt")}
                onClick={() => setEditing({ title: "", content: "" })}
                variant={"secondary"}
                size={"icon"}
              >
                <Plus className="size-4" />
              </Button>
            </div>
            <div className="min-h-32 overflow-y-auto">
              {loading ? (
                <Loader2
                  className="mx-auto my-10 size-5 animate-spin"
                  aria-label={common("loading")}
                />
              ) : (
                prompts
                  .filter((prompt) =>
                    `${prompt.title} ${prompt.content}`
                      .toLowerCase()
                      .includes(query.toLowerCase()),
                  )
                  .map((prompt) => (
                    <div
                      key={prompt.id}
                      className="flex items-center gap-1 border-b border-border py-2 last:border-0"
                    >
                      <CenterMorphModalClose>
                        <Button
                          type="button"
                          onClick={() => onInsert(prompt.content)}
                          variant={"ghost"}
                          size={"sm"}
                          className="min-w-0 flex-1 text-left"
                        >
                          <span className="block truncate text-sm font-medium">
                            {prompt.title}
                          </span>
                          <span className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground">
                            {prompt.content}
                          </span>
                        </Button>
                      </CenterMorphModalClose>
                      <Button
                        type="button"
                        aria-label={t("editPrompt", { title: prompt.title })}
                        title={t("editPrompt", { title: prompt.title })}
                        onClick={() =>
                          setEditing({
                            id: prompt.id,
                            title: prompt.title,
                            content: prompt.content,
                          })
                        }
                        variant={"ghost"}
                        size={"icon"}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      {deleting === prompt.id ? (
                        <>
                          <Button
                            type="button"
                            disabled={saving}
                            aria-label={t("confirmDelete")}
                            title={t("confirmDelete")}
                            onClick={() =>
                              void mutate({ action: "delete", id: prompt.id })
                            }
                            variant={"ghost"}
                            size={"icon"}
                          >
                            {saving ? (
                              <Loader2 className="size-4 animate-spin" />
                            ) : (
                              <Check className="size-4" />
                            )}
                          </Button>
                          <Button
                            type="button"
                            disabled={saving}
                            aria-label={common("cancel")}
                            onClick={() => setDeleting(null)}
                            variant={"ghost"}
                            size={"icon"}
                          >
                            <X className="size-4" />
                          </Button>
                        </>
                      ) : (
                        <Button
                          type="button"
                          aria-label={t("deletePrompt", {
                            title: prompt.title,
                          })}
                          title={t("deletePrompt", { title: prompt.title })}
                          onClick={() => setDeleting(prompt.id)}
                          variant={"ghost"}
                          size={"icon"}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                    </div>
                  ))
              )}
              {!loading && !prompts.length ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  {t("noPrompts")}
                </p>
              ) : null}
            </div>
          </>
        )}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </CenterMorphModalContent>
    </CenterMorphModal>
  );
}
