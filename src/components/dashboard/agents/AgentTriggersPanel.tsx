"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { ExternalLink, Plus, Trash2 } from "lucide-react";
import {
  AnimatedBadge,
  type AnimatedBadgeStatus,
} from "@/components/motion/animated-badge";
import { Button, ButtonLink } from "@/components/motion/button/base";
import { Input } from "@/components/motion/input";
import { Switch } from "@/components/motion/switch";
import { FormSelect } from "@/components/ui/FormSelect";
import { apiRequest } from "@/lib/client/api";
import { cn } from "@/lib/utils";
import type { AccountConnectionDTO } from "../account-connection-presets";
import { ConfirmSubmitButton } from "../ConfirmSubmitButton";
import { CopyButton } from "../CopyButton";
import { DialogField } from "../dialog";
import { DisplayError, displayErrorText } from "../display-error";
import { notify } from "../Toaster";
import { useRuntimeErrorText } from "../useRuntimeErrorText";
import {
  buildGitHubSourceConfig,
  buildXSourceConfig,
  buildYouTubeSourceConfig,
  extractSourceHost,
  filtersFromConfig,
  GITHUB_REASONS,
  type HttpFilter,
  type HttpFilterDraft,
  isSourceKind,
  MAX_HTTP_FILTERS,
  parseList,
  templateRequiredPreset,
  TRIGGER_TEMPLATES,
  type TriggerKind,
  type TriggerTemplateId,
} from "./trigger-templates";

type TriggerSourceConnection = {
  id: string;
  name: string;
  status: string;
  accountLabel: string | null;
};

type WebhookAuth = "bearer" | "github";

type TriggerWebhook = {
  url: string;
  auth: WebhookAuth;
  ignoredSenders: string[];
};

type TriggerDTO = {
  id: string;
  kind: TriggerKind;
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
  webhook: TriggerWebhook | null;
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
    connection: TriggerSourceConnection | null;
    lastSyncAt: string | null;
    lastSyncStatus: "succeeded" | "failed" | "rate_limited" | null;
    lastSyncError: string | null;
    syncRetryAt: string | null;
  } | null;
};

type Draft = {
  id?: string;
  kind: TriggerKind;
  template: TriggerTemplateId | null;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  delivery: TriggerDTO["delivery"];
  webhookAuth: WebhookAuth;
  webhookIgnoredSenders: string;
  connectionId: string;
  existingConnection: TriggerSourceConnection | null;
  url: string;
  itemsPath: string;
  idPath: string;
  revisionPath: string;
  filters: HttpFilterDraft[];
  githubReasons: string[];
  githubRepositories: string;
  xUserId: string;
  youtubeChannelInput: string;
};

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

const CONNECTION_STATUS_TONE: Record<string, AnimatedBadgeStatus> = {
  active: "success",
  pending: "warning",
  expired: "warning",
  failed: "danger",
};

const TEXTAREA_CLASS =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

function parseIgnoredSenders(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function emptySourceDraft() {
  return {
    connectionId: "",
    existingConnection: null as TriggerSourceConnection | null,
    url: "",
    itemsPath: "",
    idPath: "",
    revisionPath: "",
    filters: [] as HttpFilterDraft[],
    githubReasons: ["review_requested", "mention"],
    githubRepositories: "",
    xUserId: "",
    youtubeChannelInput: "",
  };
}

function draftFromTrigger(
  trigger: TriggerDTO,
  nextFilterId: () => string,
): Draft {
  const cfg = trigger.source?.config;
  return {
    id: trigger.id,
    kind: trigger.kind,
    template: null,
    name: trigger.name,
    prompt: trigger.prompt,
    cron: trigger.cron ?? "",
    timezone: trigger.timezone ?? "UTC",
    delivery: trigger.delivery,
    webhookAuth: trigger.webhook?.auth ?? "bearer",
    webhookIgnoredSenders: trigger.webhook?.ignoredSenders.join(", ") ?? "",
    ...emptySourceDraft(),
    connectionId: trigger.source?.connection?.id ?? "",
    existingConnection: trigger.source?.connection ?? null,
    url: typeof cfg?.url === "string" ? cfg.url : "",
    itemsPath: typeof cfg?.itemsPath === "string" ? cfg.itemsPath : "",
    idPath: typeof cfg?.idPath === "string" ? cfg.idPath : "",
    revisionPath: typeof cfg?.revisionPath === "string" ? cfg.revisionPath : "",
    filters: filtersFromConfig(cfg, nextFilterId),
  };
}

function pickConnectionForPreset(
  connections: AccountConnectionDTO[] | null,
  preset: string,
): string {
  if (!connections) return "";
  const active = connections.find(
    (conn) => conn.preset === preset && conn.status === "active",
  );
  if (active) return active.id;
  return connections.find((conn) => conn.preset === preset)?.id ?? "";
}

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
  const pathname =
    usePathname() ??
    `/app/${encodeURIComponent(slug)}/agents/${encodeURIComponent(agentId)}`;
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  const returnTo = `${pathname}${query ? `?${query}` : ""}`;
  const connectionsHref = `/app/${encodeURIComponent(slug)}/settings?section=connections&returnTo=${encodeURIComponent(returnTo)}`;

  const [triggers, setTriggers] = useState<TriggerDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [targets, setTargets] = useState<DeliveryConnection[] | null>(null);
  const [targetsFailed, setTargetsFailed] = useState(false);
  const [accountConnections, setAccountConnections] = useState<
    AccountConnectionDTO[] | null
  >(null);
  const [accountConnectionsFailed, setAccountConnectionsFailed] =
    useState(false);
  const [secret, setSecret] = useState<{ id: string; value: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [requestOptions, setRequestOptions] = useState({
    cache: "no-store" as const,
  });
  const [loading, setLoading] = useState(true);
  const flight = useRef(false);
  const filterSeq = useRef(0);
  const nextFilterId = () => `filter-${++filterSeq.current}`;

  const base = `/api/v1/agents/${encodeURIComponent(agentId)}/triggers`;
  const connectionsUrl = `/api/v1/workspaces/${encodeURIComponent(slug)}/account-connections`;

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
  const loadAccountConnections = useEffectEvent(
    async (url: string, signal: AbortSignal) => {
      setAccountConnections(null);
      setAccountConnectionsFailed(false);
      const result = await apiRequest<{
        connections: AccountConnectionDTO[];
      }>(url, { cache: "no-store", signal });
      if (signal.aborted) return;
      if (result.ok) {
        const list = result.data.connections;
        setAccountConnections(list);
        setDraft((current) => {
          if (!current || current.connectionId || !current.template)
            return current;
          const preset = templateRequiredPreset(current.template);
          if (!preset) return current;
          const picked = pickConnectionForPreset(list, preset);
          return picked ? { ...current, connectionId: picked } : current;
        });
      } else {
        setAccountConnectionsFailed(true);
      }
    },
  );
  useEffect(() => {
    if (draftKey === null) return;
    const controller = new AbortController();
    void loadTargets(`${base}/targets`, controller.signal);
    void loadAccountConnections(connectionsUrl, controller.signal);
    return () => controller.abort();
  }, [base, connectionsUrl, draftKey]);

  function compileTemplateToFields(current: Draft): Draft {
    if (current.template === "github") {
      const cfg = buildGitHubSourceConfig(
        current.githubReasons,
        current.githubRepositories,
      );
      return {
        ...current,
        kind: "http",
        template: null,
        url: cfg.url,
        itemsPath: cfg.itemsPath,
        idPath: cfg.idPath,
        revisionPath: cfg.revisionPath ?? "",
        filters: filtersFromConfig(cfg, nextFilterId),
      };
    }
    if (current.template === "x") {
      const cfg = buildXSourceConfig(current.xUserId || "{userId}");
      return {
        ...current,
        kind: "http",
        template: null,
        url: cfg.url,
        itemsPath: cfg.itemsPath,
        idPath: cfg.idPath,
        revisionPath: "",
        filters: [],
      };
    }
    if (current.template === "youtube") {
      const cfg = buildYouTubeSourceConfig(current.youtubeChannelInput);
      return {
        ...current,
        kind: "feed",
        template: null,
        url: cfg?.url ?? current.url,
      };
    }
    return { ...current, template: null };
  }

  function buildSourceConfig(current: Draft) {
    if (current.template === "github") {
      return buildGitHubSourceConfig(
        current.githubReasons,
        current.githubRepositories,
      );
    }
    if (current.template === "x") {
      return buildXSourceConfig(current.xUserId);
    }
    if (current.template === "youtube") {
      const cfg = buildYouTubeSourceConfig(current.youtubeChannelInput);
      if (!cfg) throw new DisplayError(t("invalidYoutubeChannel"));
      return cfg;
    }
    if (current.kind === "feed") {
      return { url: current.url.trim() };
    }
    const filters: HttpFilter[] = [];
    for (const row of current.filters) {
      const path = row.path.trim();
      const values = parseList(row.values);
      if (!path && values.length === 0) continue;
      if (!path || values.length === 0) {
        throw new DisplayError(t("invalidTriggerSource"));
      }
      filters.push({ path, values });
    }
    const revisionPath = current.revisionPath.trim();
    return {
      url: current.url.trim(),
      itemsPath: current.itemsPath.trim(),
      idPath: current.idPath.trim(),
      ...(revisionPath ? { revisionPath } : {}),
      ...(filters.length > 0 ? { filters } : {}),
    };
  }

  function selectTemplate(template: TriggerTemplateId) {
    if (!draft) return;
    const defaultPrompt = draft.prompt.trim()
      ? draft.prompt
      : t("sourcePromptTemplate", { placeholder: "{{payload}}" });
    const defaultCron = draft.cron.trim() || "*/15 * * * *";
    if (template === "github") {
      setDraft({
        ...draft,
        kind: "http",
        template: "github",
        cron: defaultCron,
        prompt: defaultPrompt,
        connectionId: pickConnectionForPreset(accountConnections, "github"),
      });
      return;
    }
    if (template === "x") {
      setDraft({
        ...draft,
        kind: "http",
        template: "x",
        cron: defaultCron,
        prompt: defaultPrompt,
        connectionId: pickConnectionForPreset(accountConnections, "x"),
      });
      return;
    }
    setDraft({
      ...draft,
      kind: "feed",
      template: "youtube",
      cron: defaultCron,
      prompt: defaultPrompt,
      connectionId: "",
    });
  }

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
              : result.message === "TRIGGER_SOURCE_HOST_NOT_ALLOWED"
                ? t("sourceHostNotAllowed")
                : result.message === "INVALID_TRIGGER_SOURCE"
                  ? t("invalidTriggerSource")
                  : result.message && t.has(`syncError.${result.message}`)
                    ? t(`syncError.${result.message}`)
                    : t("operationFailed")),
      );
    return result.data ?? {};
  }

  /** `run` may return a string to replace the default success message. */
  async function operation(run: () => Promise<unknown>, success: string) {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    try {
      const message = await run();
      notify(typeof message === "string" ? message : success);
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
  const requiredPreset = draft ? templateRequiredPreset(draft.template) : null;
  const missingPresetConnection =
    requiredPreset !== null &&
    accountConnections !== null &&
    !accountConnections.some((conn) => conn.preset === requiredPreset);

  const selectedAccountConnection = accountConnections?.find(
    (conn) => conn.id === draft?.connectionId,
  );

  const connectionStatusLabel = (status: string) =>
    t.has(`connectionStatus.${status}`)
      ? t(`connectionStatus.${status}`)
      : status;

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
                template: null,
                name: "",
                prompt: "",
                cron: "",
                delivery: null,
                webhookAuth: "bearer",
                webhookIgnoredSenders: "",
                ...emptySourceDraft(),
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
              const source = isSourceKind(draft.kind);
              const payload = {
                ...(!draft.id ? { kind: draft.kind } : {}),
                name: draft.name,
                prompt: draft.prompt,
                delivery: draft.delivery
                  ? {
                      connectionId: draft.delivery.connectionId,
                      chatId: draft.delivery.chatId.trim(),
                    }
                  : null,
                ...(draft.kind === "schedule" || source
                  ? { cron: draft.cron, timezone: draft.timezone }
                  : {}),
                ...(draft.kind === "webhook"
                  ? {
                      webhook:
                        draft.webhookAuth === "github"
                          ? {
                              auth: "github" as const,
                              ignoredSenders: parseIgnoredSenders(
                                draft.webhookIgnoredSenders,
                              ),
                            }
                          : { auth: "bearer" as const },
                    }
                  : {}),
                ...(source
                  ? {
                      sourceConfig: buildSourceConfig(draft),
                      connectionId: draft.connectionId || null,
                    }
                  : {}),
              };
              const body = await mutate(
                draft.id ? `${base}/${encodeURIComponent(draft.id)}` : base,
                draft.id ? "PATCH" : "POST",
                payload,
              );
              if (body.trigger) apply(body.trigger, body.secret);
              setDraft(null);
            }, t("saved"));
          }}
        >
          {!draft.id ? (
            <div className="space-y-3">
              <FormSelect
                label={t("kind")}
                value={draft.kind}
                disabled={locked}
                onValueChange={(value) => {
                  const kind = value as TriggerKind;
                  const baseDraft = draft.template
                    ? compileTemplateToFields(draft)
                    : draft;
                  setDraft({
                    ...baseDraft,
                    kind,
                    template: null,
                    prompt:
                      isSourceKind(kind) && !baseDraft.prompt.trim()
                        ? t("sourcePromptTemplate", {
                            placeholder: "{{payload}}",
                          })
                        : baseDraft.prompt,
                    cron:
                      isSourceKind(kind) && !baseDraft.cron.trim()
                        ? "*/15 * * * *"
                        : baseDraft.cron,
                  });
                }}
                options={[
                  { value: "schedule", label: t("schedule") },
                  { value: "webhook", label: t("webhook") },
                  { value: "feed", label: t("feed") },
                  { value: "http", label: t("http") },
                ]}
              />
              <div className="space-y-1.5">
                <span className="block text-xs font-medium text-muted-foreground">
                  {t("templates")}
                </span>
                <div className="flex flex-wrap gap-2">
                  {TRIGGER_TEMPLATES.map((tpl) => {
                    const active = draft.template === tpl;
                    return (
                      <button
                        key={tpl}
                        type="button"
                        disabled={locked}
                        onClick={() => selectTemplate(tpl)}
                        className={cn(
                          "rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          active
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border bg-card text-foreground hover:bg-muted/60",
                        )}
                      >
                        {tpl === "github"
                          ? t("github")
                          : tpl === "x"
                            ? t("x")
                            : t("youtube")}
                      </button>
                    );
                  })}
                  {draft.template ? (
                    <button
                      type="button"
                      disabled={locked}
                      onClick={() => setDraft(compileTemplateToFields(draft))}
                      className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                    >
                      {t("customFields")}
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
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

          {draft.template === "github" ? (
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
                        checked={draft.githubReasons.includes(reason)}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            githubReasons: event.target.checked
                              ? [...draft.githubReasons, reason]
                              : draft.githubReasons.filter(
                                  (item) => item !== reason,
                                ),
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
                  value={draft.githubRepositories}
                  disabled={locked}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      githubRepositories: event.target.value,
                    })
                  }
                  className={TEXTAREA_CLASS}
                />
              </DialogField>
            </>
          ) : null}

          {draft.template === "x" ? (
            <DialogField label={t("xUserId")} htmlFor="trigger-x-user">
              <Input
                id="trigger-x-user"
                required
                value={draft.xUserId}
                disabled={locked}
                onChange={(xUserId) => setDraft({ ...draft, xUserId })}
              />
            </DialogField>
          ) : null}

          {draft.template === "youtube" ? (
            <DialogField label={t("youtubeChannelId")} htmlFor="trigger-yt">
              <Input
                id="trigger-yt"
                required
                placeholder="UC… / https://www.youtube.com/channel/UC…"
                value={draft.youtubeChannelInput}
                disabled={locked}
                onChange={(youtubeChannelInput) =>
                  setDraft({ ...draft, youtubeChannelInput })
                }
              />
            </DialogField>
          ) : null}

          {!draft.template && isSourceKind(draft.kind) ? (
            <>
              <DialogField label={t("sourceUrl")} htmlFor="trigger-source-url">
                <Input
                  id="trigger-source-url"
                  type="url"
                  required
                  placeholder="https://…"
                  value={draft.url}
                  disabled={locked}
                  onChange={(url) => setDraft({ ...draft, url })}
                />
              </DialogField>

              {draft.kind === "http" ? (
                <>
                  <div className="grid gap-4 sm:grid-cols-3">
                    <DialogField
                      label={t("itemsPath")}
                      htmlFor="trigger-items-path"
                    >
                      <Input
                        id="trigger-items-path"
                        placeholder={t("itemsPathPlaceholder")}
                        value={draft.itemsPath}
                        disabled={locked}
                        onChange={(itemsPath) =>
                          setDraft({ ...draft, itemsPath })
                        }
                      />
                    </DialogField>
                    <DialogField label={t("idPath")} htmlFor="trigger-id-path">
                      <Input
                        id="trigger-id-path"
                        required
                        placeholder="id"
                        value={draft.idPath}
                        disabled={locked}
                        onChange={(idPath) => setDraft({ ...draft, idPath })}
                      />
                    </DialogField>
                    <DialogField
                      label={t("revisionPath")}
                      htmlFor="trigger-revision-path"
                    >
                      <Input
                        id="trigger-revision-path"
                        placeholder="updated_at"
                        value={draft.revisionPath}
                        disabled={locked}
                        onChange={(revisionPath) =>
                          setDraft({ ...draft, revisionPath })
                        }
                      />
                    </DialogField>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium">
                        {t("filters")}
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={
                          locked || draft.filters.length >= MAX_HTTP_FILTERS
                        }
                        onClick={() =>
                          setDraft({
                            ...draft,
                            filters: [
                              ...draft.filters,
                              { id: nextFilterId(), path: "", values: "" },
                            ],
                          })
                        }
                      >
                        <Plus className="size-3.5" aria-hidden="true" />
                        {t("addFilter")}
                      </Button>
                    </div>
                    {draft.filters.map((row) => (
                      <div
                        key={row.id}
                        className="grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_auto]"
                      >
                        <DialogField
                          label={t("filterPath")}
                          htmlFor={`${row.id}-path`}
                        >
                          <Input
                            id={`${row.id}-path`}
                            placeholder="reason"
                            value={row.path}
                            disabled={locked}
                            onChange={(path) =>
                              setDraft({
                                ...draft,
                                filters: draft.filters.map((item) =>
                                  item.id === row.id ? { ...item, path } : item,
                                ),
                              })
                            }
                          />
                        </DialogField>
                        <DialogField
                          label={t("filterValues")}
                          htmlFor={`${row.id}-values`}
                        >
                          <Input
                            id={`${row.id}-values`}
                            placeholder={t("filterValuesPlaceholder")}
                            value={row.values}
                            disabled={locked}
                            onChange={(values) =>
                              setDraft({
                                ...draft,
                                filters: draft.filters.map((item) =>
                                  item.id === row.id
                                    ? { ...item, values }
                                    : item,
                                ),
                              })
                            }
                          />
                        </DialogField>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          disabled={locked}
                          aria-label={t("removeFilter")}
                          onClick={() =>
                            setDraft({
                              ...draft,
                              filters: draft.filters.filter(
                                (item) => item.id !== row.id,
                              ),
                            })
                          }
                        >
                          <Trash2 className="size-4" aria-hidden="true" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </>
              ) : null}
            </>
          ) : null}

          {isSourceKind(draft.kind) ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label
                  htmlFor="trigger-account-connection"
                  className="text-sm font-medium"
                >
                  {t("accountConnection")}
                </label>
                <ButtonLink
                  href={connectionsHref}
                  size="sm"
                  variant="ghost"
                  className="h-auto px-2 py-1 text-xs"
                >
                  {t("manageConnections")}
                  <ExternalLink className="size-3" aria-hidden="true" />
                </ButtonLink>
              </div>
              <FormSelect
                id="trigger-account-connection"
                label={t("accountConnection")}
                value={draft.connectionId}
                disabled={locked || accountConnections === null}
                onValueChange={(connectionId) =>
                  setDraft({ ...draft, connectionId })
                }
                options={[
                  { value: "", label: t("connectionNone") },
                  ...(draft.connectionId &&
                  !selectedAccountConnection &&
                  draft.existingConnection
                    ? [
                        {
                          value: draft.existingConnection.id,
                          label: `${draft.existingConnection.name}${draft.existingConnection.accountLabel ? ` (${draft.existingConnection.accountLabel})` : ""}`,
                        },
                      ]
                    : []),
                  ...(accountConnections ?? []).map((conn) => ({
                    value: conn.id,
                    label: `${conn.name}${conn.accountLabel ? ` (${conn.accountLabel})` : ""} · ${connectionStatusLabel(conn.status)}`,
                  })),
                ]}
              />
              {accountConnectionsFailed ? (
                <p role="alert" className="text-xs text-destructive">
                  {t("connectionsLoadFailed")}
                </p>
              ) : accountConnections === null ? (
                <p role="status" className="text-xs text-muted-foreground">
                  {common("loading")}
                </p>
              ) : null}
              {missingPresetConnection && requiredPreset ? (
                <div
                  role="status"
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs"
                >
                  <span>
                    {t("missingTemplateConnection", {
                      preset: t(`presetName.${requiredPreset}`),
                    })}
                  </span>
                  <ButtonLink
                    href={connectionsHref}
                    size="sm"
                    variant="secondary"
                  >
                    {t("manageConnections")}
                  </ButtonLink>
                </div>
              ) : null}
            </div>
          ) : null}

          {draft.kind === "schedule" || isSourceKind(draft.kind) ? (
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

          {draft.kind === "webhook" ? (
            <div className="space-y-4">
              <DialogField
                label={t("webhookAuth")}
                htmlFor="trigger-webhook-auth"
                description={t(`webhookAuthHint.${draft.webhookAuth}`)}
              >
                <FormSelect
                  id="trigger-webhook-auth"
                  label={t("webhookAuth")}
                  value={draft.webhookAuth}
                  disabled={locked}
                  onValueChange={(value) =>
                    setDraft({ ...draft, webhookAuth: value as WebhookAuth })
                  }
                  options={[
                    { value: "bearer", label: t("webhookAuthMode.bearer") },
                    { value: "github", label: t("webhookAuthMode.github") },
                  ]}
                />
              </DialogField>
              {draft.webhookAuth === "github" ? (
                <DialogField
                  label={t("webhookIgnoredSenders")}
                  htmlFor="trigger-webhook-ignored-senders"
                  description={t("webhookIgnoredSendersHint")}
                >
                  <Input
                    id="trigger-webhook-ignored-senders"
                    placeholder="octocat, my-agent"
                    value={draft.webhookIgnoredSenders}
                    disabled={locked}
                    onChange={(webhookIgnoredSenders) =>
                      setDraft({ ...draft, webhookIgnoredSenders })
                    }
                  />
                </DialogField>
              ) : null}
            </div>
          ) : null}

          <DialogField
            label={t("prompt")}
            htmlFor="trigger-prompt"
            description={
              draft.kind === "webhook"
                ? t("payloadHint", {
                    placeholder: "{{payload}}",
                    eventPlaceholder: "{{event}}",
                  })
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
              className={TEXTAREA_CLASS}
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
      {triggers?.map((trigger) => {
        const sourceHost = trigger.source
          ? extractSourceHost(trigger.source.config)
          : null;
        return (
          <section
            key={trigger.id}
            className="space-y-3 rounded-xl border border-border p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold">{trigger.name}</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t(trigger.kind)}
                  {trigger.webhook
                    ? ` · ${t(`webhookAuthMode.${trigger.webhook.auth}`)}`
                    : ""}
                  {trigger.cron
                    ? ` · ${trigger.cron} · ${trigger.timezone}`
                    : ""}
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
              <div className="space-y-1.5">
                {sourceHost || trigger.source.connection ? (
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {sourceHost ? (
                      <span className="font-mono">{sourceHost}</span>
                    ) : null}
                    {trigger.source.connection ? (
                      <>
                        {sourceHost ? <span>·</span> : null}
                        <span>
                          {trigger.source.connection.name}
                          {trigger.source.connection.accountLabel
                            ? ` (${trigger.source.connection.accountLabel})`
                            : ""}
                        </span>
                        <AnimatedBadge
                          status={
                            CONNECTION_STATUS_TONE[
                              trigger.source.connection.status
                            ] ?? "neutral"
                          }
                          size="sm"
                        >
                          {connectionStatusLabel(
                            trigger.source.connection.status,
                          )}
                        </AnimatedBadge>
                      </>
                    ) : null}
                  </div>
                ) : null}
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
              </div>
            ) : null}
            {trigger.delivery || trigger.lastDeliveryStatus ? (
              <div className="space-y-1 text-xs text-muted-foreground">
                {trigger.delivery ? (
                  <p className="break-words">
                    {trigger.delivery.connectionName} ·{" "}
                    {trigger.delivery.chatId}
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
            {trigger.webhook?.url ? (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 break-all text-xs">
                    {trigger.webhook.url}
                  </code>
                  <CopyButton
                    text={trigger.webhook.url}
                    label={common("copy")}
                  />
                </div>
                {trigger.webhook.auth === "github" ? (
                  <p className="text-xs text-muted-foreground">
                    {t("githubWebhookCardHint")}
                  </p>
                ) : null}
              </div>
            ) : null}
            {secret?.id === trigger.id ? (
              <div
                role="status"
                className="space-y-2 rounded-lg border border-border bg-muted/40 p-3"
              >
                <p className="text-xs">
                  {trigger.webhook?.auth === "github"
                    ? t("secretOnceGithub")
                    : t("secretOnce")}
                </p>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 break-all text-xs">
                    {secret.value}
                  </code>
                  <CopyButton text={secret.value} label={common("copy")} />
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setSecret(null)}
                >
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
                  setDraft(draftFromTrigger(trigger, nextFilterId))
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
                    // A subscription poll without new items starts no run;
                    // reload to show the sync result instead.
                    if (isSourceKind(trigger.kind) && !body.conversationId) {
                      setRequestOptions({ cache: "no-store" });
                      return t("syncedNoNewItems");
                    }
                    setTriggers(
                      (previous) =>
                        previous?.map((item) =>
                          item.id === trigger.id
                            ? {
                                ...item,
                                lastStatus: "running",
                                lastError: null,
                                lastConversationId:
                                  body.conversationId ??
                                  item.lastConversationId,
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
                        previous?.filter((item) => item.id !== trigger.id) ??
                        [],
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
        );
      })}
    </div>
  );
}
