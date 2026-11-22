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
import { DisplayError, displayErrorText } from "../display-error";
import { apiRequest } from "@/lib/client/api";

type TriggerDTO = {
  id: string;
  kind: "schedule" | "webhook" | SourceKind;
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
  delivery: {
    connectionId: string;
    connectionName: string;
    platform: string;
    chatId: string;
  } | null;
  lastDeliveryStatus:
    | "pending"
    | "sending"
    | "delivered"
    | "skipped"
    | "failed"
    | null;
  lastDeliveryError: string | null;
  lastDeliveryAt: string | null;
  source: {
    config: Record<string, unknown>;
    hasCredential: boolean;
    lastSyncAt: string | null;
    lastSyncStatus: "succeeded" | "failed" | "rate_limited" | null;
    lastSyncError: string | null;
    syncRetryAt: string | null;
  } | null;
};
type Draft = {
  id?: string;
  kind: TriggerDTO["kind"];
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  delivery: TriggerDTO["delivery"];
  reasons: string[];
  repositories: string;
  userId: string;
  channelId: string;
  credential: string;
  hasCredential: boolean;
};
type SourceKind = "github" | "x" | "youtube";
const SOURCE_KINDS: readonly string[] = ["github", "x", "youtube"];
const isSource = (kind: string): kind is SourceKind =>
  SOURCE_KINDS.includes(kind);
const GITHUB_REASONS = [
  "review_requested",
  "mention",
  "team_mention",
  "assign",
  "author",
  "comment",
  "state_change",
  "ci_activity",
] as const;
const strings = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
function draftSource(config: Record<string, unknown> | undefined) {
  return {
    reasons: config?.reasons
      ? strings(config.reasons)
      : ["review_requested", "mention"],
    repositories: strings(config?.repositories).join("\n"),
    userId: typeof config?.userId === "string" ? config.userId : "",
    channelId: typeof config?.channelId === "string" ? config.channelId : "",
    credential: "",
  };
}
function sourceConfig(draft: Draft) {
  if (draft.kind === "github")
    return {
      reasons: draft.reasons,
      repositories: draft.repositories
        .split(/\s+/)
        .map((line) => line.trim())
        .filter(Boolean),
    };
  if (draft.kind === "x") return { userId: draft.userId.trim() };
  return { channelId: draft.channelId.trim() };
}
type DeliveryConnection = {
  id: string;
  name: string;
  platform: string;
  status: string;
  chats: Array<{
    chatId: string;
    chatType: "dm" | "group" | "channel" | "thread";
    label: string;
    lastSeenAt: string;
  }>;
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
  const [targets, setTargets] = useState<DeliveryConnection[] | null>(null);
  const [targetsFailed, setTargetsFailed] = useState(false);
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
    async (
      url: string,
      signal: AbortSignal,
      options: { cache: "no-store" },
    ) => {
      setLoading(true);
      const result = await apiRequest<{ triggers: TriggerDTO[] }>(url, {
        ...options,
        signal,
      });
      if (signal.aborted) return;
      if (result.ok) {
        setTriggers(result.data.triggers);
        setError(null);
      } else setError(result.message ?? t("loadFailed"));
      setLoading(false);
    },
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(base, controller.signal, requestOptions);
    return () => controller.abort();
  }, [base, requestOptions]);

  const draftKey = draft ? (draft.id ?? "new") : null;
  const loadTargets = useEffectEvent(
    async (url: string, signal: AbortSignal) => {
      setTargets(null);
      setTargetsFailed(false);
      const result = await apiRequest<{ connections: DeliveryConnection[] }>(
        url,
        { cache: "no-store", signal },
      );
      if (signal.aborted) return;
      if (result.ok) setTargets(result.data.connections);
      else setTargetsFailed(true);
    },
  );
  useEffect(() => {
    if (draftKey === null) return;
    const controller = new AbortController();
    void loadTargets(`${base}/targets`, controller.signal);
    return () => controller.abort();
  }, [base, draftKey]);

  async function mutate(path: string, method: string, data?: unknown) {
    const result = await apiRequest<{
      trigger?: TriggerDTO;
      secret?: string;
      conversationId?: string;
    }>(path, { method, json: data });
    if (!result.ok)
      throw new DisplayError(
        runtimeError(result.message)?.text ??
          (result.message === "INVALID_TRIGGER"
            ? t("invalidTrigger")
            : result.message === "INVALID_TRIGGER_DELIVERY"
              ? t("invalidTriggerDelivery")
              : result.message === "INVALID_TRIGGER_SOURCE"
                ? t("invalidTriggerSource")
                : t("operationFailed")),
      );
    return result.data ?? {};
  }
  async function operation(run: () => Promise<void>, success: string) {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    try {
      await run();
      notify(success);
    } catch (cause) {
      notify(displayErrorText(cause, t("operationFailed")), {
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
  const deliveryConnection = targets?.find(
    (connection) => connection.id === draft?.delivery?.connectionId,
  );
  return (
    <div className="space-y-5 px-6 py-5">
      <header className="flex items-center justify-end gap-3">
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
                delivery: null,
                ...draftSource(undefined),
                hasCredential: false,
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
                  delivery: draft.delivery
                    ? {
                        connectionId: draft.delivery.connectionId,
                        chatId: draft.delivery.chatId.trim(),
                      }
                    : null,
                  ...(draft.kind === "schedule" || isSource(draft.kind)
                    ? { cron: draft.cron, timezone: draft.timezone }
                    : {}),
                  ...(isSource(draft.kind)
                    ? {
                        sourceConfig: sourceConfig(draft),
                        ...(draft.credential.trim()
                          ? { credential: draft.credential.trim() }
                          : {}),
                      }
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
              onValueChange={(value) => {
                const kind = value as Draft["kind"];
                setDraft({
                  ...draft,
                  kind,
                  prompt:
                    isSource(kind) && !draft.prompt.trim()
                      ? t("sourcePromptTemplate", {
                          placeholder: "{{payload}}",
                        })
                      : draft.prompt,
                  cron:
                    isSource(kind) && !draft.cron.trim()
                      ? "*/15 * * * *"
                      : draft.cron,
                });
              }}
              options={[
                { value: "schedule", label: t("schedule") },
                { value: "webhook", label: t("webhook") },
                { value: "github", label: t("github") },
                { value: "x", label: t("x") },
                { value: "youtube", label: t("youtube") },
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
          {draft.kind === "github" ? (
            <>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">
                  {t("githubReasons")}
                </legend>
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {GITHUB_REASONS.map((reason) => (
                    <label
                      key={reason}
                      className="flex items-center gap-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        disabled={locked}
                        checked={draft.reasons.includes(reason)}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            reasons: event.target.checked
                              ? [...draft.reasons, reason]
                              : draft.reasons.filter((item) => item !== reason),
                          })
                        }
                      />
                      {t(`githubReason.${reason}`)}
                    </label>
                  ))}
                </div>
              </fieldset>
              <DialogField
                label={t("githubRepositories")}
                htmlFor="trigger-repositories"
                description={t("githubRepositoriesHint")}
              >
                <textarea
                  id="trigger-repositories"
                  rows={2}
                  placeholder="owner/repo"
                  value={draft.repositories}
                  disabled={locked}
                  onChange={(event) =>
                    setDraft({ ...draft, repositories: event.target.value })
                  }
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </DialogField>
            </>
          ) : null}
          {draft.kind === "x" ? (
            <DialogField label={t("xUserId")} htmlFor="trigger-x-user">
              <Input
                id="trigger-x-user"
                required
                value={draft.userId}
                disabled={locked}
                onChange={(userId) => setDraft({ ...draft, userId })}
              />
            </DialogField>
          ) : null}
          {draft.kind === "youtube" ? (
            <DialogField label={t("youtubeChannelId")} htmlFor="trigger-yt">
              <Input
                id="trigger-yt"
                required
                placeholder="UC…"
                value={draft.channelId}
                disabled={locked}
                onChange={(channelId) => setDraft({ ...draft, channelId })}
              />
            </DialogField>
          ) : null}
          {draft.kind === "github" || draft.kind === "x" ? (
            <DialogField
              label={t(draft.kind === "github" ? "githubToken" : "xToken")}
              htmlFor="trigger-credential"
              description={
                draft.hasCredential ? t("credentialKeep") : undefined
              }
            >
              <Input
                id="trigger-credential"
                type="password"
                autoComplete="off"
                required={!draft.hasCredential}
                value={draft.credential}
                disabled={locked}
                onChange={(credential) => setDraft({ ...draft, credential })}
              />
            </DialogField>
          ) : null}
          {draft.kind === "schedule" || isSource(draft.kind) ? (
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
          <div className="space-y-3">
            <DialogField
              label={t("sendResultToChannel")}
              htmlFor="trigger-delivery-connection"
            >
              <FormSelect
                id="trigger-delivery-connection"
                label={t("sendResultToChannel")}
                value={draft.delivery?.connectionId ?? ""}
                disabled={locked || targets === null}
                onValueChange={(connectionId) => {
                  const connection = targets?.find(
                    (item) => item.id === connectionId,
                  );
                  setDraft({
                    ...draft,
                    delivery: connection
                      ? {
                          connectionId: connection.id,
                          connectionName: connection.name,
                          platform: connection.platform,
                          chatId: "",
                        }
                      : null,
                  });
                }}
                options={[
                  { value: "", label: t("deliveryNone") },
                  ...(draft.delivery && !deliveryConnection
                    ? [
                        {
                          value: draft.delivery.connectionId,
                          label: `${draft.delivery.connectionName} · ${draft.delivery.platform}`,
                        },
                      ]
                    : []),
                  ...(targets ?? []).map((connection) => ({
                    value: connection.id,
                    label: `${connection.name} · ${connection.platform}`,
                  })),
                ]}
              />
            </DialogField>
            {targetsFailed ? (
              <p role="alert" className="text-sm text-destructive">
                {t("deliveryTargetsLoadFailed")}
              </p>
            ) : targets === null ? (
              <p role="status" className="text-sm text-muted-foreground">
                {common("loading")}
              </p>
            ) : null}
            {draft.delivery ? (
              <>
                {deliveryConnection?.chats.length ? (
                  <FormSelect
                    label={t("deliveryKnownChat")}
                    disabled={locked}
                    value={
                      deliveryConnection.chats.some(
                        (chat) => chat.chatId === draft.delivery?.chatId,
                      )
                        ? draft.delivery.chatId
                        : ""
                    }
                    onValueChange={(chatId) =>
                      setDraft({
                        ...draft,
                        delivery: draft.delivery
                          ? { ...draft.delivery, chatId }
                          : null,
                      })
                    }
                    options={[
                      { value: "", label: t("deliveryManualChat") },
                      ...deliveryConnection.chats.map((chat) => ({
                        value: chat.chatId,
                        label: `${chat.label} · ${t(`deliveryChatType.${chat.chatType}`)}`,
                      })),
                    ]}
                  />
                ) : null}
                <DialogField
                  label={t("deliveryChatId")}
                  htmlFor="trigger-delivery-chat-id"
                  description={t("deliveryChatIdHint")}
                >
                  <Input
                    id="trigger-delivery-chat-id"
                    required
                    maxLength={256}
                    value={draft.delivery.chatId}
                    disabled={locked}
                    onChange={(chatId) =>
                      setDraft({
                        ...draft,
                        delivery: draft.delivery
                          ? { ...draft.delivery, chatId }
                          : null,
                      })
                    }
                  />
                </DialogField>
              </>
            ) : null}
          </div>
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
          {trigger.source ? (
            <p
              role="status"
              className={
                trigger.source.lastSyncStatus &&
                trigger.source.lastSyncStatus !== "succeeded"
                  ? "break-words text-xs text-destructive"
                  : "text-xs text-muted-foreground"
              }
            >
              {trigger.source.lastSyncAt
                ? t("lastSync", { date: date(trigger.source.lastSyncAt) })
                : t("neverSynced")}
              {trigger.source.lastSyncStatus
                ? ` · ${t(`syncStatus.${trigger.source.lastSyncStatus}`)}`
                : ""}
              {trigger.source.lastSyncError
                ? ` · ${
                    t.has(`syncError.${trigger.source.lastSyncError}`)
                      ? t(`syncError.${trigger.source.lastSyncError}`)
                      : trigger.source.lastSyncError
                  }`
                : ""}
              {trigger.source.syncRetryAt
                ? ` · ${t("syncRetry", { date: date(trigger.source.syncRetryAt) })}`
                : ""}
            </p>
          ) : null}
          {trigger.delivery || trigger.lastDeliveryStatus ? (
            <div className="space-y-1 text-xs text-muted-foreground">
              {trigger.delivery ? (
                <p className="break-words">
                  {trigger.delivery.connectionName} · {trigger.delivery.chatId}
                </p>
              ) : null}
              {trigger.lastDeliveryStatus ? (
                <p
                  role="status"
                  className={
                    trigger.lastDeliveryStatus === "failed"
                      ? "text-destructive"
                      : undefined
                  }
                >
                  {t(`deliveryStatus.${trigger.lastDeliveryStatus}`)}
                  {trigger.lastDeliveryAt
                    ? ` · ${date(trigger.lastDeliveryAt)}`
                    : ""}
                </p>
              ) : null}
              {trigger.lastDeliveryStatus === "failed" &&
              trigger.lastDeliveryError ? (
                <p className="break-words text-destructive">
                  {t.has(`deliveryError.${trigger.lastDeliveryError}`)
                    ? t(`deliveryError.${trigger.lastDeliveryError}`)
                    : trigger.lastDeliveryError}
                </p>
              ) : null}
            </div>
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
                  delivery: trigger.delivery,
                  ...draftSource(trigger.source?.config),
                  hasCredential: trigger.source?.hasCredential ?? false,
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
