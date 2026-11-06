"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, ButtonLink } from "@/components/motion/button/base";
import { Input } from "@/components/motion/input";
import { Switch } from "@/components/motion/switch";
import { FormSelect } from "@/components/ui/FormSelect";
import { DialogField } from "../dialog";
import { CopyButton } from "../CopyButton";
import { ConfirmSubmitButton } from "../ConfirmSubmitButton";
import { notify } from "../Toaster";
import { useRuntimeErrorText } from "../useRuntimeErrorText";

type TriggerDTO = {
  id: string;
  kind: "schedule" | "webhook";
  name: string;
  enabled: boolean;
  cron: string | null;
  timezone: string | null;
  prompt: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: "running" | "succeeded" | "failed" | null;
  lastError: string | null;
  lastConversationId: string | null;
  webhookUrl: string | null;
  createdAt: string;
};
type Draft = {
  id?: string;
  kind: TriggerDTO["kind"];
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
};

export function AgentTriggersPanel({
  agentId,
  slug,
  canManage,
}: {
  agentId: string;
  slug: string;
  canManage: boolean;
}) {
  const t = useTranslations("console.agentAutomation");
  const common = useTranslations("common");
  const runtimeError = useRuntimeErrorText();
  const [triggers, setTriggers] = useState<TriggerDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [secret, setSecret] = useState<{ id: string; value: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [requestOptions, setRequestOptions] = useState({
    cache: "no-store" as const,
  });
  const [loading, setLoading] = useState(true);
  const flight = useRef(false);
  const base = `/api/v1/agents/${encodeURIComponent(agentId)}/triggers`;
  const load = useEffectEvent(
    (url: string, signal: AbortSignal, options: { cache: "no-store" }) => {
      setLoading(true);
      void fetch(url, { ...options, signal })
        .then(async (response) => {
          if (!response.ok) throw new Error();
          const body: { triggers: TriggerDTO[] } = await response.json();
          if (!signal.aborted) {
            setTriggers(body.triggers);
            setError(null);
          }
        })
        .catch(() => {
          if (!signal.aborted) setError(t("loadFailed"));
        })
        .finally(() => {
          if (!signal.aborted) setLoading(false);
        });
    },
  );
  useEffect(() => {
    const controller = new AbortController();
    load(base, controller.signal, requestOptions);
    return () => controller.abort();
  }, [base, requestOptions]);

  async function mutate(path: string, method: string, data?: unknown) {
    const response = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const body = response.status === 204 ? {} : await response.json();
    if (!response.ok)
      throw new Error(
        runtimeError(body.error)?.text ??
          (body.error === "INVALID_TRIGGER"
            ? t("invalidTrigger")
            : t("operationFailed")),
      );
    return body as {
      trigger?: TriggerDTO;
      secret?: string;
      conversationId?: string;
    };
  }
  async function operation(run: () => Promise<void>, success: string) {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    try {
      await run();
      notify(success);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : t("operationFailed"), {
        severity: "error",
      });
    } finally {
      flight.current = false;
      setBusy(false);
    }
  }
  function apply(trigger: TriggerDTO, value?: string) {
    setTriggers((previous) =>
      previous?.some((item) => item.id === trigger.id)
        ? previous.map((item) => (item.id === trigger.id ? trigger : item))
        : [...(previous ?? []), trigger],
    );
    if (value) setSecret({ id: trigger.id, value });
  }
  const locked = busy || loading || !canManage;
  const date = (value: string) => new Date(value).toLocaleString();
  return (
    <div className="space-y-5 px-6 py-5">
      <header className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t("triggers")}</h2>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || loading}
            onClick={() => {
              setLoading(true);
              setRequestOptions({ cache: "no-store" });
            }}
          >
            {t("refresh")}
          </Button>
          <Button
            disabled={locked || triggers === null}
            onClick={() => {
              setDraft({
                kind: "schedule",
                name: "",
                prompt: "",
                cron: "",
                timezone:
                  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
              });
            }}
            size="sm"
          >
            {t("createTrigger")}
          </Button>
        </div>
      </header>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          {common("loading")}
        </p>
      ) : null}
      {draft ? (
        <form
          className="space-y-4 rounded-xl border border-border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void operation(async () => {
              const body = await mutate(
                draft.id ? `${base}/${encodeURIComponent(draft.id)}` : base,
                draft.id ? "PATCH" : "POST",
                {
                  ...(!draft.id ? { kind: draft.kind } : {}),
                  name: draft.name,
                  prompt: draft.prompt,
                  ...(draft.kind === "schedule"
                    ? { cron: draft.cron, timezone: draft.timezone }
                    : {}),
                },
              );
              if (body.trigger) apply(body.trigger, body.secret);
              setDraft(null);
            }, t("saved"));
          }}
        >
          {!draft.id ? (
            <FormSelect
              label={t("kind")}
              value={draft.kind}
              onValueChange={(kind) =>
                setDraft({ ...draft, kind: kind as Draft["kind"] })
              }
              options={[
                { value: "schedule", label: t("schedule") },
                { value: "webhook", label: t("webhook") },
              ]}
            />
          ) : null}
          <DialogField label={t("name")} htmlFor="trigger-name">
            <Input
              id="trigger-name"
              required
              value={draft.name}
              disabled={locked}
              onChange={(name) => setDraft({ ...draft, name })}
            />
          </DialogField>
          {draft.kind === "schedule" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <DialogField label={t("cron")} htmlFor="trigger-cron">
                <Input
                  id="trigger-cron"
                  placeholder="0 9 * * *"
                  required
                  value={draft.cron}
                  disabled={locked}
                  onChange={(cron) => setDraft({ ...draft, cron })}
                />
              </DialogField>
              <DialogField label={t("timezone")} htmlFor="trigger-timezone">
                <Input
                  id="trigger-timezone"
                  required
                  value={draft.timezone}
                  disabled={locked}
                  onChange={(timezone) => setDraft({ ...draft, timezone })}
                />
              </DialogField>
            </div>
          ) : null}
          <DialogField
            label={t("prompt")}
            htmlFor="trigger-prompt"
            description={
              draft.kind === "webhook"
                ? t("payloadHint", { placeholder: "{{payload}}" })
                : undefined
            }
          >
            <textarea
              id="trigger-prompt"
              required
              rows={4}
              value={draft.prompt}
              disabled={locked}
              onChange={(event) =>
                setDraft({ ...draft, prompt: event.target.value })
              }
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </DialogField>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => setDraft(null)}
            >
              {common("cancel")}
            </Button>
            <Button type="submit" disabled={locked}>
              {common("save")}
            </Button>
          </div>
        </form>
      ) : null}
      {triggers?.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noTriggers")}</p>
      ) : null}
      {triggers?.map((trigger) => (
        <section
          key={trigger.id}
          className="space-y-3 rounded-xl border border-border p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">{trigger.name}</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {t(trigger.kind)}
                {trigger.cron ? ` · ${trigger.cron} · ${trigger.timezone}` : ""}
              </p>
            </div>
            <Switch
              checked={trigger.enabled}
              ariaLabel={t("enabled", { name: trigger.name })}
              disabled={locked}
              onCheckedChange={(enabled) =>
                void operation(async () => {
                  const body = await mutate(
                    `${base}/${encodeURIComponent(trigger.id)}`,
                    "PATCH",
                    { enabled },
                  );
                  if (body.trigger) apply(body.trigger);
                }, t("saved"))
              }
            />
          </div>
          {trigger.nextRunAt ? (
            <p className="text-xs text-muted-foreground">
              {t("nextRun", { date: date(trigger.nextRunAt) })}
            </p>
          ) : null}
          {trigger.lastStatus ? (
            <p
              role="status"
              className={
                trigger.lastStatus === "failed"
                  ? "text-sm text-destructive"
                  : "text-sm text-muted-foreground"
              }
            >
              {t(`status.${trigger.lastStatus}`)}
              {trigger.lastRunAt ? ` · ${date(trigger.lastRunAt)}` : ""}
            </p>
          ) : null}
          {trigger.lastError ? (
            <p className="break-words text-sm text-destructive">
              {runtimeError(trigger.lastError)?.text ?? trigger.lastError}
            </p>
          ) : null}
          {trigger.webhookUrl ? (
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all text-xs">
                {trigger.webhookUrl}
              </code>
              <CopyButton text={trigger.webhookUrl} label={common("copy")} />
            </div>
          ) : null}
          {secret?.id === trigger.id ? (
            <div
              role="status"
              className="space-y-2 rounded-lg border border-border bg-muted/40 p-3"
            >
              <p className="text-xs">{t("secretOnce")}</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all text-xs">
                  {secret.value}
                </code>
                <CopyButton text={secret.value} label={common("copy")} />
              </div>
              <Button size="sm" variant="ghost" onClick={() => setSecret(null)}>
                {common("close")}
              </Button>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={locked}
              onClick={() =>
                setDraft({
                  id: trigger.id,
                  kind: trigger.kind,
                  name: trigger.name,
                  prompt: trigger.prompt,
                  cron: trigger.cron ?? "",
                  timezone: trigger.timezone ?? "UTC",
                })
              }
            >
              {common("edit")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={locked || trigger.lastStatus === "running"}
              onClick={() =>
                void operation(async () => {
                  const body = await mutate(
                    `${base}/${encodeURIComponent(trigger.id)}/run`,
                    "POST",
                  );
                  setTriggers(
                    (previous) =>
                      previous?.map((item) =>
                        item.id === trigger.id
                          ? {
                              ...item,
                              lastStatus: "running",
                              lastError: null,
                              lastConversationId:
                                body.conversationId ?? item.lastConversationId,
                            }
                          : item,
                      ) ?? [],
                  );
                }, t("runStarted"))
              }
            >
              {t("runNow")}
            </Button>
            {trigger.kind === "webhook" ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={locked}
                onClick={() =>
                  void operation(async () => {
                    const body = await mutate(
                      `${base}/${encodeURIComponent(trigger.id)}`,
                      "PATCH",
                      { rotateSecret: true },
                    );
                    if (body.trigger) apply(body.trigger, body.secret);
                  }, t("saved"))
                }
              >
                {t("rotateSecret")}
              </Button>
            ) : null}
            {trigger.lastConversationId ? (
              <ButtonLink
                size="sm"
                variant="ghost"
                href={`/app/${encodeURIComponent(slug)}/agents/${encodeURIComponent(agentId)}?c=${encodeURIComponent(trigger.lastConversationId)}`}
              >
                {t("lastConversation")}
              </ButtonLink>
            ) : null}
            <form
              action={async () => {
                await operation(async () => {
                  await mutate(
                    `${base}/${encodeURIComponent(trigger.id)}`,
                    "DELETE",
                  );
                  setTriggers(
                    (previous) =>
                      previous?.filter((item) => item.id !== trigger.id) ?? [],
                  );
                  if (secret?.id === trigger.id) setSecret(null);
                }, t("deleted"));
              }}
            >
              <ConfirmSubmitButton
                disabled={locked}
                triggerLabel={common("delete")}
                confirmLabel={common("delete")}
                cancelLabel={common("cancel")}
                prompt={t("deleteConfirm", { name: trigger.name })}
                triggerSize="sm"
                confirmClassName="bg-destructive text-destructive-foreground"
              />
            </form>
          </div>
        </section>
      ))}
    </div>
  );
}
