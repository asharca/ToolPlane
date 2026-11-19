"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Input } from "@/components/motion/input";
import { Button } from "@/components/motion/button/base";
import { StatefulButton } from "@/components/motion/button/stateful";
import { ConfirmSubmitButton } from "../ConfirmSubmitButton";
import { DialogField } from "../dialog";
import { notify } from "../Toaster";
import { apiRequest } from "@/lib/client/api";

type Memory = {
  id: string;
  content: string;
  conversationId: string | null;
  creatorType: "tool" | "user";
  createdAt: string;
};

type MemoryList = {
  memories: Memory[];
  total: number;
  maxMemories: number;
};

const memoryErrors = {
  Unauthorized: "memoryUnauthorized",
  Forbidden: "memoryForbidden",
  notFound: "AGENT_MEMORY_NOT_FOUND",
  AGENT_MEMORY_INVALID: "AGENT_MEMORY_INVALID",
  AGENT_MEMORY_SECRET_DETECTED: "AGENT_MEMORY_SECRET_DETECTED",
  AGENT_MEMORY_LIMIT_REACHED: "AGENT_MEMORY_LIMIT_REACHED",
  AGENT_MEMORY_NOT_FOUND: "AGENT_MEMORY_NOT_FOUND",
  AGENT_MEMORY_FAILED: "AGENT_MEMORY_FAILED",
} as const;
type MemoryError = (typeof memoryErrors)[keyof typeof memoryErrors];

function memoryError(message: string | null): MemoryError {
  return message && Object.hasOwn(memoryErrors, message)
    ? memoryErrors[message as keyof typeof memoryErrors]
    : "AGENT_MEMORY_FAILED";
}

export function AgentMemoriesPanel({
  slug,
  agentId,
}: {
  slug: string;
  agentId: string;
}) {
  const t = useTranslations("console.agents");
  const common = useTranslations("common");
  const format = useFormatter();
  const id = useId();
  const [query, setQuery] = useState("");
  const [content, setContent] = useState("");
  const [data, setData] = useState<MemoryList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<MemoryError | null>(null);
  const [busy, setBusy] = useState<"add" | "delete" | null>(null);
  const [reload, setReload] = useState(0);
  const listRequest = useRef<AbortController | null>(null);
  const mutation = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const base = `/api/v1/agents/${encodeURIComponent(agentId)}/memories`;
  const search = query.trim();
  const trimmedContent = content.trim();
  const contentLength = Array.from(trimmedContent).length;
  const invalidContent = contentLength > 2000 || content.includes("\0");
  const atLimit = data !== null && data.total >= data.maxMemories;

  useEffect(() => {
    return () => mutation.current?.abort();
  }, []);

  useEffect(() => {
    void reload;
    const controller = new AbortController();
    listRequest.current = controller;
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    const timer = window.setTimeout(
      async () => {
        if (search.length > 200 || search.includes("\0")) {
          setError("AGENT_MEMORY_INVALID");
          setLoading(false);
          return;
        }
        const params = new URLSearchParams({ workspace: slug });
        if (search) params.set("query", search);
        const result = await apiRequest<MemoryList>(`${base}?${params}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (controller.signal.aborted || current !== generation.current) return;
        if (result.ok) setData(result.data);
        else setError(memoryError(result.message));
        setLoading(false);
      },
      search ? 250 : 0,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [base, slug, search, reload]);

  async function mutate(memoryId?: string) {
    if (mutation.current) return;
    if (!memoryId && (!trimmedContent || invalidContent || atLimit)) {
      notify(
        t(atLimit ? "AGENT_MEMORY_LIMIT_REACHED" : "AGENT_MEMORY_INVALID"),
        { severity: "error" },
      );
      return;
    }
    const controller = new AbortController();
    mutation.current = controller;
    setBusy(memoryId ? "delete" : "add");
    const result = await apiRequest(
      memoryId
        ? `${base}/${encodeURIComponent(memoryId)}?${new URLSearchParams({ workspace: slug })}`
        : base,
      {
        method: memoryId ? "DELETE" : "POST",
        signal: controller.signal,
        json: memoryId
          ? undefined
          : { workspace: slug, content: trimmedContent },
      },
    );
    if (mutation.current === controller) mutation.current = null;
    if (controller.signal.aborted) return;
    setBusy(null);
    if (!result.ok) {
      notify(t(memoryError(result.message)), { severity: "error" });
      return;
    }
    // Invalidate any pre-mutation list before accepting the refreshed count.
    generation.current += 1;
    listRequest.current?.abort();
    if (memoryId) {
      setData((previous) =>
        previous
          ? {
              ...previous,
              memories: previous.memories.filter(
                (memory) => memory.id !== memoryId,
              ),
              total: Math.max(0, previous.total - 1),
            }
          : previous,
      );
      searchRef.current?.focus();
    } else {
      setContent("");
    }
    notify(t(memoryId ? "memoryDeleted" : "memorySaved"));
    setReload((value) => value + 1);
  }

  return (
    <section aria-label={t("memories")} className="min-w-0 space-y-5 px-6 py-5">
      <div className="flex items-center justify-end gap-3">
        {data ? (
          <span
            className="text-sm tabular-nums text-muted-foreground"
            aria-live="polite"
          >
            {t("memoryCount", { total: data.total, max: data.maxMemories })}
          </span>
        ) : null}
      </div>
      <form action={async () => mutate()} className="space-y-3">
        <DialogField label={t("memoryContent")} htmlFor={`${id}-content`}>
          <textarea
            id={`${id}-content`}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            rows={3}
            required
            disabled={busy !== null}
            aria-invalid={invalidContent || undefined}
            aria-describedby={
              invalidContent ? `${id}-content-error` : `${id}-length`
            }
            className="w-full rounded-lg border border-border bg-background p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          />
        </DialogField>
        {invalidContent ? (
          <p
            id={`${id}-content-error`}
            role="alert"
            className="text-sm text-destructive"
          >
            {t("AGENT_MEMORY_INVALID")}
          </p>
        ) : null}
        {atLimit ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t("AGENT_MEMORY_LIMIT_REACHED")}
          </p>
        ) : null}
        <div className="flex items-center justify-between gap-3">
          <span
            id={`${id}-length`}
            className="text-xs tabular-nums text-muted-foreground"
          >
            {t("memoryCharacterCount", { count: contentLength })}
          </span>
          <StatefulButton
            type="submit"
            size="sm"
            state={busy === "add" ? "loading" : "idle"}
            loadingText={common("loading")}
            disabled={
              busy !== null || !trimmedContent || invalidContent || atLimit
            }
          >
            {t("memoryAdd")}
          </StatefulButton>
        </div>
      </form>
      <Input
        ref={searchRef}
        type="search"
        label={t("memorySearch")}
        value={query}
        onChange={setQuery}
        maxLength={200}
      />
      <div aria-busy={loading} className="space-y-3">
        {loading ? (
          <p role="status" className="text-sm text-muted-foreground">
            {common("loading")}
          </p>
        ) : error ? (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-destructive">
              {t(error)}
            </p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setReload((value) => value + 1)}
            >
              {t("memoryReload")}
            </Button>
          </div>
        ) : data?.memories.length ? (
          <>
            {search ? (
              <p role="status" className="text-xs text-muted-foreground">
                {t("memorySearchResults", { count: data.memories.length })}
              </p>
            ) : null}
            <ul className="divide-y divide-border">
              {data.memories.map((memory) => (
                <li
                  key={memory.id}
                  className="min-w-0 space-y-3 py-4 first:pt-0"
                >
                  <p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">
                    {memory.content}
                  </p>
                  <dl className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
                    <div>
                      <dt className="sr-only">{t("memoryCreator")}</dt>
                      <dd>
                        {t(
                          memory.creatorType === "tool"
                            ? "memoryCreatorTool"
                            : "memoryCreatorUser",
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt className="sr-only">{t("memoryCreatedAt")}</dt>
                      <dd>
                        <time dateTime={memory.createdAt}>
                          {format.dateTime(new Date(memory.createdAt), {
                            dateStyle: "medium",
                            timeStyle: "short",
                          })}
                        </time>
                      </dd>
                    </div>
                    <div className="flex min-w-0 basis-full flex-wrap gap-x-2">
                      <dt>{t("memorySourceConversation")}</dt>
                      <dd className="break-all">
                        {memory.conversationId ?? t("memoryNoConversation")}
                      </dd>
                    </div>
                  </dl>
                  <form action={async () => mutate(memory.id)}>
                    <ConfirmSubmitButton
                      triggerLabel={t("memoryDelete")}
                      confirmLabel={common("delete")}
                      cancelLabel={common("cancel")}
                      prompt={t("memoryDeleteConfirm")}
                      pendingLabel={common("loading")}
                      disabled={busy !== null}
                      triggerVariant="ghost"
                      triggerSize="sm"
                      confirmClassName="text-destructive"
                    />
                  </form>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {t("memoryEmpty")}
          </p>
        )}
      </div>
    </section>
  );
}
