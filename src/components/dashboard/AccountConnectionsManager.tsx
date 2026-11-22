"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { ExternalLink, Link2, Plus, RefreshCw } from "lucide-react";
import {
  AnimatedBadge,
  type AnimatedBadgeStatus,
} from "@/components/motion/animated-badge";
import { Button } from "@/components/motion/button/base";
import {
  CenterMorphModal,
  CenterMorphModalContent,
} from "@/components/motion/center-morph-modal";
import { Input } from "@/components/motion/input";
import { FormSelect } from "@/components/ui/FormSelect";
import { apiRequest } from "@/lib/client/api";
import { cn } from "@/lib/utils";
import {
  type AccountConnectionAuthType,
  type AccountConnectionDTO,
  type AccountConnectionStatus,
  buildConnectionPayload,
  CONNECTION_AUTH_TYPES,
  CONNECTION_TEMPLATE_IDS,
  type ConnectionDraft,
  draftFromConnection,
  draftFromTemplate,
  GITHUB_CREATE_TOKEN_URL,
} from "./account-connection-presets";
import { ConfirmSubmitButton } from "./ConfirmSubmitButton";
import { CopyButton } from "./CopyButton";
import { DashboardEmptyState } from "./DashboardUI";
import { DialogBody, DialogField, DialogFooter, DialogHeader } from "./dialog";
import { DisplayError, displayErrorText } from "./display-error";
import { notify } from "./Toaster";

const STATUS_TONE: Record<AccountConnectionStatus, AnimatedBadgeStatus> = {
  active: "success",
  pending: "warning",
  expired: "warning",
  failed: "danger",
};

const TEXTAREA_CLASS =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

export function AccountConnectionsManager({
  slug,
  canManage,
}: {
  slug: string;
  canManage: boolean;
}) {
  const t = useTranslations("console.accountConnections");
  const common = useTranslations("common");
  const router = useRouter();
  const pathname = usePathname() ?? `/app/${encodeURIComponent(slug)}/settings`;
  const searchParams = useSearchParams();

  const [connections, setConnections] = useState<AccountConnectionDTO[] | null>(
    null,
  );
  const [redirectUri, setRedirectUri] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ConnectionDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const flight = useRef(false);
  const handledCallbackRef = useRef<string | null>(null);

  const base = `/api/v1/workspaces/${encodeURIComponent(slug)}/account-connections`;

  const translateError = useEffectEvent(
    (code: string | null | undefined, fallback: string) =>
      code && t.has(`error.${code}`) ? t(`error.${code}`) : fallback,
  );

  const load = useEffectEvent(
    async (url: string, signal: AbortSignal, _reload: number) => {
      setLoading(true);
      const result = await apiRequest<{
        connections: AccountConnectionDTO[];
        redirectUri: string;
      }>(url, { cache: "no-store", signal });
      if (signal.aborted) return;
      if (result.ok) {
        setConnections(result.data.connections);
        setRedirectUri(result.data.redirectUri ?? "");
        setError(null);
      } else {
        setError(translateError(result.message, t("loadFailed")));
      }
      setLoading(false);
    },
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(base, controller.signal, reloadTick);
    return () => controller.abort();
  }, [base, reloadTick]);

  const handleCallback = useEffectEvent((callbackError: string | null) => {
    if (callbackError) {
      notify(translateError(callbackError, t("oauthFailed")), {
        severity: "error",
      });
    } else {
      notify(t("oauthConnected"));
    }
    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.delete("connection");
    nextParams.delete("error");
    const qs = nextParams.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  });
  const callbackConnection = searchParams.get("connection");
  const callbackError = searchParams.get("error");
  useEffect(() => {
    if (!callbackConnection && !callbackError) return;
    const key = `${callbackConnection ?? ""}:${callbackError ?? ""}`;
    if (handledCallbackRef.current === key) return;
    handledCallbackRef.current = key;
    handleCallback(callbackError);
  }, [callbackConnection, callbackError]);

  function upsert(connection: AccountConnectionDTO) {
    setConnections((previous) =>
      previous?.some((item) => item.id === connection.id)
        ? previous.map((item) =>
            item.id === connection.id ? connection : item,
          )
        : [...(previous ?? []), connection],
    );
  }

  async function runAction(
    action: () => Promise<void>,
    successMessage?: string,
    fallbackError?: string,
  ) {
    if (flight.current) return false;
    flight.current = true;
    setBusy(true);
    try {
      await action();
      if (successMessage) notify(successMessage);
      return true;
    } catch (cause) {
      notify(displayErrorText(cause, fallbackError ?? t("operationFailed")), {
        severity: "error",
      });
      return false;
    } finally {
      flight.current = false;
      setBusy(false);
    }
  }

  async function handleSave(current: ConnectionDraft) {
    const ok = await runAction(async () => {
      const payload = buildConnectionPayload(current);
      const result = await apiRequest<{ connection: AccountConnectionDTO }>(
        current.id ? `${base}/${encodeURIComponent(current.id)}` : base,
        { method: current.id ? "PATCH" : "POST", json: payload },
      );
      if (!result.ok) {
        throw new DisplayError(
          translateError(result.message, t("operationFailed")),
        );
      }
      upsert(result.data.connection);
    }, t("saved"));
    if (ok) setDraft(null);
  }

  async function handleTest(connection: AccountConnectionDTO) {
    setTestingId(connection.id);
    try {
      await runAction(
        async () => {
          const result = await apiRequest<{ connection: AccountConnectionDTO }>(
            `${base}/${encodeURIComponent(connection.id)}/test`,
            { method: "POST" },
          );
          if (!result.ok) {
            setReloadTick((tick) => tick + 1);
            throw new DisplayError(
              translateError(result.message, t("testFailed")),
            );
          }
          upsert(result.data.connection);
        },
        t("testSucceeded"),
        t("testFailed"),
      );
    } finally {
      setTestingId(null);
    }
  }

  async function handleOAuthStart(connection: AccountConnectionDTO) {
    setConnectingId(connection.id);
    try {
      await runAction(
        async () => {
          const result = await apiRequest<{ authorizationUrl: string }>(
            `${base}/${encodeURIComponent(connection.id)}/oauth/start`,
            { method: "POST" },
          );
          if (!result.ok || !result.data?.authorizationUrl) {
            throw new DisplayError(
              translateError(
                result.ok ? undefined : result.message,
                t("oauthFailed"),
              ),
            );
          }
          window.location.assign(result.data.authorizationUrl);
        },
        undefined,
        t("oauthFailed"),
      );
    } finally {
      setConnectingId(null);
    }
  }

  async function handleDelete(connection: AccountConnectionDTO) {
    await runAction(async () => {
      const result = await apiRequest<void>(
        `${base}/${encodeURIComponent(connection.id)}`,
        { method: "DELETE" },
      );
      if (!result.ok) {
        throw new DisplayError(
          translateError(result.message, t("operationFailed")),
        );
      }
      setConnections(
        (previous) =>
          previous?.filter((item) => item.id !== connection.id) ?? [],
      );
    }, t("deleted"));
  }

  const locked = busy || loading || !canManage;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{t("title")}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy || loading}
            onClick={() => setReloadTick((tick) => tick + 1)}
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            {t("refresh")}
          </Button>
          {canManage ? (
            <Button
              type="button"
              size="sm"
              disabled={locked || connections === null}
              onClick={() => setDraft(draftFromTemplate("github_token"))}
            >
              <Plus className="size-3.5" aria-hidden="true" />
              {t("create")}
            </Button>
          ) : null}
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {loading && connections === null ? (
        <p role="status" className="text-sm text-muted-foreground">
          {common("loading")}
        </p>
      ) : null}

      {connections?.length === 0 ? (
        <DashboardEmptyState
          icon={Link2}
          title={t("empty")}
          actions={
            canManage ? (
              <Button
                type="button"
                size="sm"
                onClick={() => setDraft(draftFromTemplate("github_token"))}
              >
                {t("create")}
              </Button>
            ) : undefined
          }
        />
      ) : null}

      {connections?.length ? (
        <div className="space-y-3">
          {connections.map((connection) => {
            const isTesting = testingId === connection.id;
            const isConnecting = connectingId === connection.id;
            return (
              <section
                key={connection.id}
                className="space-y-3 rounded-xl border border-border bg-card p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold">
                        {connection.name}
                      </h3>
                      <AnimatedBadge
                        status={STATUS_TONE[connection.status] ?? "neutral"}
                        size="sm"
                      >
                        {t(`status.${connection.status}`)}
                      </AnimatedBadge>
                      {connection.accountLabel ? (
                        <span className="truncate text-xs text-muted-foreground">
                          {connection.accountLabel}
                        </span>
                      ) : null}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t(`preset.${connection.preset}`)}
                      {" · "}
                      {t(`authType.${connection.authType}`)}
                      {" · "}
                      {t("usage", { count: connection.usage })}
                    </p>
                    {connection.allowedHosts.length > 0 ? (
                      <p className="break-all font-mono text-xs text-muted-foreground">
                        {connection.allowedHosts.join(", ")}
                      </p>
                    ) : null}
                  </div>

                  {canManage ? (
                    <div className="flex flex-wrap items-center gap-2">
                      {connection.authType === "oauth2" ? (
                        <Button
                          type="button"
                          size="sm"
                          variant={
                            connection.status === "pending"
                              ? "primary"
                              : "secondary"
                          }
                          disabled={locked}
                          onClick={() => void handleOAuthStart(connection)}
                        >
                          {isConnecting
                            ? t("connecting")
                            : connection.status === "pending"
                              ? t("connect")
                              : t("reconnect")}
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={locked}
                        onClick={() => void handleTest(connection)}
                      >
                        {isTesting ? t("testing") : t("test")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={locked}
                        onClick={() =>
                          setDraft(draftFromConnection(connection))
                        }
                      >
                        {common("edit")}
                      </Button>
                      <form
                        action={async () => {
                          await handleDelete(connection);
                        }}
                      >
                        <ConfirmSubmitButton
                          disabled={locked}
                          triggerLabel={common("delete")}
                          confirmLabel={common("delete")}
                          cancelLabel={common("cancel")}
                          prompt={t("deleteConfirm", { name: connection.name })}
                          triggerSize="sm"
                          confirmClassName="bg-destructive text-destructive-foreground"
                        />
                      </form>
                    </div>
                  ) : null}
                </div>

                {connection.lastError ? (
                  <p
                    role="alert"
                    className="break-words text-xs text-destructive"
                  >
                    {t.has(`error.${connection.lastError}`)
                      ? t(`error.${connection.lastError}`)
                      : t("operationFailed")}
                  </p>
                ) : null}

                {connection.authType === "oauth2" && redirectUri ? (
                  <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
                    <span className="text-xs text-muted-foreground">
                      {t("redirectUri")}
                    </span>
                    <code className="min-w-0 flex-1 break-all text-xs">
                      {redirectUri}
                    </code>
                    <CopyButton text={redirectUri} label={common("copy")} />
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      ) : null}

      {/* biome-ignore lint/a11y/noStaticElementInteractions: Escape inside a nested dialog must stop here, before the settings dialog's listener closes it too. */}
      <div
        className="contents"
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !draft || busy) return;
          event.preventDefault();
          event.stopPropagation();
          setDraft(null);
        }}
      >
        <CenterMorphModal
          open={draft !== null}
          onOpenChange={(open) => {
            if (!open && !busy) setDraft(null);
          }}
        >
          <CenterMorphModalContent
            ariaLabel={draft?.id ? t("editTitle") : t("createTitle")}
            closeButtonLabel={common("close")}
            className="flex max-h-[calc(100dvh-3rem)] w-full max-w-2xl flex-col overflow-hidden"
          >
            {draft ? (
              <>
                <DialogHeader
                  title={draft.id ? t("editTitle") : t("createTitle")}
                />
                <form
                  className="flex min-h-0 flex-1 flex-col overflow-hidden"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void handleSave(draft);
                  }}
                >
                  <DialogBody className="min-h-0 flex-1 overflow-y-auto">
                    {!draft.id ? (
                      <div className="space-y-2">
                        <span className="block text-sm font-medium">
                          {t("presetLabel")}
                        </span>
                        <div className="flex flex-wrap gap-2">
                          {CONNECTION_TEMPLATE_IDS.map((templateId) => {
                            const active = draft.templateId === templateId;
                            return (
                              <button
                                key={templateId}
                                type="button"
                                disabled={busy}
                                onClick={() =>
                                  setDraft(
                                    draftFromTemplate(templateId, draft.name),
                                  )
                                }
                                className={cn(
                                  "rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                  active
                                    ? "border-primary bg-primary text-primary-foreground"
                                    : "border-border bg-card text-foreground hover:bg-muted/60",
                                )}
                              >
                                {t(`template.${templateId}`)}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}

                    <DialogField label={t("name")} htmlFor="conn-name">
                      <Input
                        id="conn-name"
                        required
                        maxLength={80}
                        value={draft.name}
                        disabled={busy}
                        onChange={(name) => setDraft({ ...draft, name })}
                      />
                    </DialogField>

                    <DialogField
                      label={t("authTypeLabel")}
                      htmlFor="conn-auth-type"
                    >
                      <FormSelect
                        id="conn-auth-type"
                        label={t("authTypeLabel")}
                        value={draft.authType}
                        disabled={busy || Boolean(draft.id)}
                        onValueChange={(next) => {
                          const authType = next as AccountConnectionAuthType;
                          setDraft({ ...draft, authType });
                        }}
                        options={CONNECTION_AUTH_TYPES.map((type) => ({
                          value: type,
                          label: t(`authType.${type}`),
                        }))}
                      />
                    </DialogField>

                    {draft.authType === "header" ? (
                      <DialogField
                        label={t("headerName")}
                        htmlFor="conn-header"
                      >
                        <Input
                          id="conn-header"
                          required
                          maxLength={128}
                          placeholder="X-API-Key"
                          value={draft.headerName}
                          disabled={busy}
                          onChange={(headerName) =>
                            setDraft({ ...draft, headerName })
                          }
                        />
                      </DialogField>
                    ) : null}

                    {draft.authType === "query" ? (
                      <DialogField label={t("queryName")} htmlFor="conn-query">
                        <Input
                          id="conn-query"
                          required
                          maxLength={128}
                          placeholder="api_key"
                          value={draft.queryName}
                          disabled={busy}
                          onChange={(queryName) =>
                            setDraft({ ...draft, queryName })
                          }
                        />
                      </DialogField>
                    ) : null}

                    {draft.authType === "basic" ? (
                      <DialogField
                        label={t("username")}
                        htmlFor="conn-username"
                      >
                        <Input
                          id="conn-username"
                          required
                          maxLength={1024}
                          value={draft.username}
                          disabled={busy}
                          onChange={(username) =>
                            setDraft({ ...draft, username })
                          }
                        />
                      </DialogField>
                    ) : null}

                    {draft.authType === "oauth2" ? (
                      <>
                        {redirectUri ? (
                          <DialogField label={t("redirectUri")}>
                            <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
                              <code className="min-w-0 flex-1 break-all text-xs">
                                {redirectUri}
                              </code>
                              <CopyButton
                                text={redirectUri}
                                label={common("copy")}
                              />
                            </div>
                          </DialogField>
                        ) : null}
                        <DialogField
                          label={t("authorizationUrl")}
                          htmlFor="conn-auth-url"
                        >
                          <Input
                            id="conn-auth-url"
                            type="url"
                            required
                            value={draft.authorizationUrl}
                            disabled={busy}
                            onChange={(authorizationUrl) =>
                              setDraft({ ...draft, authorizationUrl })
                            }
                          />
                        </DialogField>
                        <DialogField
                          label={t("tokenUrl")}
                          htmlFor="conn-token-url"
                        >
                          <Input
                            id="conn-token-url"
                            type="url"
                            required
                            value={draft.tokenUrl}
                            disabled={busy}
                            onChange={(tokenUrl) =>
                              setDraft({ ...draft, tokenUrl })
                            }
                          />
                        </DialogField>
                        <DialogField
                          label={t("clientId")}
                          htmlFor="conn-client-id"
                        >
                          <Input
                            id="conn-client-id"
                            required
                            value={draft.clientId}
                            disabled={busy}
                            onChange={(clientId) =>
                              setDraft({ ...draft, clientId })
                            }
                          />
                        </DialogField>
                        <DialogField
                          label={t("scopes")}
                          htmlFor="conn-scopes"
                          description={t("scopesHint")}
                        >
                          <Input
                            id="conn-scopes"
                            value={draft.scopes}
                            disabled={busy}
                            onChange={(scopes) =>
                              setDraft({ ...draft, scopes })
                            }
                          />
                        </DialogField>
                        <DialogField
                          label={t("clientAuth")}
                          htmlFor="conn-client-auth"
                        >
                          <FormSelect
                            id="conn-client-auth"
                            label={t("clientAuth")}
                            value={draft.clientAuth}
                            disabled={busy}
                            onValueChange={(value) =>
                              setDraft({
                                ...draft,
                                clientAuth:
                                  value === "basic" ? "basic" : "body",
                              })
                            }
                            options={[
                              {
                                value: "body",
                                label: t("clientAuthOption.body"),
                              },
                              {
                                value: "basic",
                                label: t("clientAuthOption.basic"),
                              },
                            ]}
                          />
                        </DialogField>
                        <DialogField
                          label={t("extraParams")}
                          htmlFor="conn-extra-params"
                          description={t("extraParamsHint")}
                        >
                          <textarea
                            id="conn-extra-params"
                            rows={2}
                            placeholder="access_type=offline"
                            value={draft.extraParams}
                            disabled={busy}
                            onChange={(event) =>
                              setDraft({
                                ...draft,
                                extraParams: event.target.value,
                              })
                            }
                            className={TEXTAREA_CLASS}
                          />
                        </DialogField>
                      </>
                    ) : null}

                    <DialogField
                      label={t(`secretLabel.${draft.authType}`)}
                      htmlFor="conn-secret"
                      description={
                        draft.id &&
                        (draft.hasSecret || draft.authType !== "oauth2")
                          ? t("secretKeep")
                          : undefined
                      }
                    >
                      <div className="space-y-1.5">
                        <Input
                          id="conn-secret"
                          type="password"
                          autoComplete="off"
                          required={!draft.id && draft.authType !== "oauth2"}
                          value={draft.secret}
                          disabled={busy}
                          onChange={(secret) => setDraft({ ...draft, secret })}
                        />
                        {draft.preset === "github" &&
                        draft.authType === "bearer" ? (
                          <a
                            href={GITHUB_CREATE_TOKEN_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                          >
                            {t("createGithubToken")}
                            <ExternalLink
                              className="size-3"
                              aria-hidden="true"
                            />
                          </a>
                        ) : null}
                      </div>
                    </DialogField>

                    <DialogField
                      label={t("allowedHosts")}
                      htmlFor="conn-hosts"
                      description={t("allowedHostsHint")}
                    >
                      <textarea
                        id="conn-hosts"
                        required
                        rows={2}
                        placeholder="api.github.com"
                        value={draft.allowedHosts}
                        disabled={busy}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            allowedHosts: event.target.value,
                          })
                        }
                        className={TEXTAREA_CLASS}
                      />
                    </DialogField>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <DialogField label={t("testUrl")} htmlFor="conn-test-url">
                        <Input
                          id="conn-test-url"
                          type="url"
                          placeholder="https://api.github.com/user"
                          value={draft.testUrl}
                          disabled={busy}
                          onChange={(testUrl) =>
                            setDraft({ ...draft, testUrl })
                          }
                        />
                      </DialogField>
                      <DialogField
                        label={t("accountPath")}
                        htmlFor="conn-account-path"
                      >
                        <Input
                          id="conn-account-path"
                          placeholder="login"
                          value={draft.accountPath}
                          disabled={busy || !draft.testUrl.trim()}
                          onChange={(accountPath) =>
                            setDraft({ ...draft, accountPath })
                          }
                        />
                      </DialogField>
                    </div>
                  </DialogBody>

                  <DialogFooter>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setDraft(null)}
                    >
                      {common("cancel")}
                    </Button>
                    <Button type="submit" disabled={busy}>
                      {common("save")}
                    </Button>
                  </DialogFooter>
                </form>
              </>
            ) : null}
          </CenterMorphModalContent>
        </CenterMorphModal>
      </div>
    </div>
  );
}
