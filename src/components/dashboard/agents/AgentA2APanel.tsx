"use client";
import { Button, ButtonLink } from "@/components/motion/button/base";

import { AnimatedBadge } from "@/components/motion/animated-badge";
import { BouncyAccordion } from "@/components/motion/bouncy-accordion";
import { Loader } from "@/components/motion/loader";
import { Switch } from "@/components/motion/switch";
import { ConfirmActionDialog } from "@/components/dashboard/ConversationUxPrimitives";

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { useTranslations } from "next-intl";

import { ArrowUpRight, BookOpen, KeyRound, RefreshCw } from "lucide-react";
import { AgentA2ARemotes } from "./AgentA2ARemotes";
import { AgentA2ATaskMonitor } from "./AgentA2ATaskMonitor";
import { CopyButton } from "@/components/dashboard/CopyButton";
import {
  DisplayError,
  displayErrorText,
} from "@/components/dashboard/display-error";
import { notify } from "@/components/dashboard/Toaster";
import type { A2AConsoleView } from "@/lib/a2a/connection-info";
import type { A2AConsoleAction } from "@/lib/a2a/console-service";
import { isExecutableAgentRuntimeKind } from "@/lib/agents/runtime-kind";
import { apiRequest } from "@/lib/client/api";

const cardClass =
  "space-y-4 rounded-xl border border-border/60 bg-background p-4 sm:p-5";

export function AgentA2APanel({
  slug,
  agentId,
  runtimeKind,
  initialTaskId,
  onConfigureTargets,
}: {
  slug: string;
  agentId: string;
  runtimeKind: string;
  initialTaskId?: string;
  onConfigureTargets?: () => void;
}) {
  const t = useTranslations("console.agents.a2a");
  const common = useTranslations("common");
  const [view, setView] = useState<A2AConsoleView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"local" | "public">("local");
  const [revokeKeyId, setRevokeKeyId] = useState<string | null>(null);
  const flight = useRef(false);
  const mounted = useRef(true);
  const base = `/api/v1/workspaces/${encodeURIComponent(slug)}/agents/${encodeURIComponent(agentId)}/a2a/console`;
  /** Resolves to the failure text, or null once the view is current. */
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const result = await apiRequest<A2AConsoleView>(base, {
        cache: "no-store",
        signal,
      });
      if (!result.ok) return result.message ?? t("loadFailed");
      if (mounted.current && !signal?.aborted) setView(result.data);
      return null;
    },
    [base, t],
  );
  const loadInitial = useEffectEvent(async (signal: AbortSignal) => {
    const failure = await load(signal);
    if (failure && !signal.aborted) setError(failure);
  });
  useEffect(() => {
    void base; // Target identity alone controls the initial fetch lifecycle.
    mounted.current = true;
    const controller = new AbortController();
    void loadInitial(controller.signal);
    return () => {
      mounted.current = false;
      controller.abort();
    };
    // Reload only when the target changes, not the translation function identity.
  }, [base]);

  async function operation(run: () => Promise<void>) {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    setError("");
    try {
      await run();
    } catch (cause) {
      if (mounted.current)
        setError(displayErrorText(cause, t("operationFailed")));
    } finally {
      flight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function refresh() {
    const failure = await load();
    if (failure) throw new DisplayError(failure);
  }
  async function mutate(action: A2AConsoleAction) {
    if (!isExecutableAgentRuntimeKind(runtimeKind)) return;
    await operation(async () => {
      const result = await apiRequest(base, { method: "POST", json: action });
      if (!result.ok)
        throw new DisplayError(result.message ?? t("operationFailed"));
      if (!mounted.current) return;
      notify(t("saved"));
      if ((await load()) && mounted.current) setError(t("refreshFailed"));
    });
  }
  const connection = view?.connections;
  const rpcUrl =
    mode === "local" ? connection?.localRpc : connection?.publicRpc;
  const cardUrl =
    mode === "local" ? connection?.localCard : connection?.publicCard;
  const executable = isExecutableAgentRuntimeKind(runtimeKind);
  const locked = busy || !view?.canManage || !executable;

  return (
    <div className="min-w-0 space-y-5 px-6 py-5">
      {!executable ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("retiredRuntime")}
        </p>
      ) : null}
      <header className="flex justify-end">
        <Button
          disabled={busy}
          onClick={() => void operation(refresh)}
          variant="secondary"
          size="sm"
        >
          <RefreshCw className="mr-1 size-4" />
          {t("refresh")}
        </Button>
      </header>
      {error ? (
        <div role="alert" className="space-y-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}
      {!view ? (
        <div
          role="status"
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <Loader size={18} label={t("loading")} />
          <span>{t("loading")}</span>
        </div>
      ) : (
        <>
          {!view.canManage ? (
            <div
              role="alert"
              className="space-y-2 text-sm text-muted-foreground"
            >
              {t("readOnly")}
            </div>
          ) : null}
          <section className={cardClass} aria-labelledby="a2a-policy-heading">
            <h3 id="a2a-policy-heading" className="font-semibold">
              {t("internalTitle")}
            </h3>
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <h4 className="text-sm font-medium">{t("inboundTitle")}</h4>
                  <p className="text-xs text-muted-foreground">
                    {t("inboundDescription")}
                  </p>
                </div>
                <Switch
                  checked={view.collaboration.inboundEnabled}
                  ariaLabel={t("inboundTitle")}
                  disabled={
                    locked ||
                    (!isExecutableAgentRuntimeKind(runtimeKind) &&
                      !view.collaboration.inboundEnabled)
                  }
                  onCheckedChange={(enabled) =>
                    void mutate({ action: "set-inbound", enabled })
                  }
                />
              </div>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <h4 className="text-sm font-medium">{t("outboundTitle")}</h4>
                  <p className="text-xs text-muted-foreground">
                    {t("outboundDescription")}
                  </p>
                </div>
                <Switch
                  checked={view.collaboration.outboundEnabled}
                  ariaLabel={t("outboundTitle")}
                  disabled={
                    locked ||
                    (!isExecutableAgentRuntimeKind(runtimeKind) &&
                      !view.collaboration.outboundEnabled)
                  }
                  onCheckedChange={(enabled) =>
                    void mutate({ action: "set-outbound", enabled })
                  }
                />
              </div>
            </div>
            {!view.local.supported ? (
              <div
                role="alert"
                className="space-y-2 text-sm text-muted-foreground"
              >
                {t("unsupportedLocal")}
              </div>
            ) : !view.local.ready ? (
              <div
                role="alert"
                className="space-y-2 text-sm text-muted-foreground"
              >
                {t("localNotReady")}
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {t("sandboxWarning")}
            </p>
            <BouncyAccordion
              items={[
                {
                  id: "collaboration-details",
                  title: t("details"),
                  description: (
                    <div className="space-y-2 pt-3 text-xs text-muted-foreground">
                      <p>{t("internalDescription")}</p>
                      <p>{t("authorizedTargetsOnly")}</p>
                      <p>{t("boundaries")}</p>
                    </div>
                  ),
                },
              ]}
            />
            {executable ? (
              onConfigureTargets ? (
                <button
                  type="button"
                  onClick={onConfigureTargets}
                  className="text-left text-sm underline underline-offset-4"
                >
                  {t("configureTargets")}
                </button>
              ) : (
                <a
                  className="text-sm underline underline-offset-4"
                  href="?settings=subAgents"
                >
                  {t("configureTargets")}
                </a>
              )
            ) : null}
          </section>
          {view.endpoint ? (
            <section className={cardClass} aria-labelledby="a2a-public-heading">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 id="a2a-public-heading" className="font-semibold">
                    {t("publicTitle")}
                  </h3>
                </div>
                <AnimatedBadge
                  status={view.endpoint?.enabled ? "success" : "neutral"}
                >
                  {t(view.endpoint?.enabled ? "enabled" : "disabled")}
                </AnimatedBadge>
              </div>
              <p className="text-sm text-muted-foreground">
                {t("publicBoundary")}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("revision", { version: view.endpoint?.revision ?? "—" })}
              </p>
            </section>
          ) : null}
          <section className={cardClass} aria-labelledby="a2a-connect-heading">
            <h3 id="a2a-connect-heading" className="font-semibold">
              {t("connectionTitle")}
            </h3>
            {!connection ? (
              <div
                role="alert"
                className="space-y-2 text-sm text-muted-foreground"
              >
                {t("invalidOrigin")}
              </div>
            ) : null}
            {view.endpoint ? (
              <fieldset
                className="m-0 flex min-w-0 flex-wrap gap-2 border-0 p-0"
                aria-label={t("connectionMode")}
              >
                <Button
                  aria-pressed={mode === "local"}
                  onClick={() => setMode("local")}
                  variant={mode === "local" ? "primary" : "secondary"}
                  size={"sm"}
                >
                  {t("localTitle")}
                </Button>
                <Button
                  aria-pressed={mode === "public"}
                  onClick={() => setMode("public")}
                  variant={mode === "public" ? "primary" : "secondary"}
                  size={"sm"}
                >
                  {t("publicTitle")}
                </Button>
              </fieldset>
            ) : null}
            <p className="text-sm text-muted-foreground">
              {t(mode === "local" ? "accountCredential" : "serviceCredential")}
            </p>
            {isExecutableAgentRuntimeKind(runtimeKind) ? (
              <p className="text-xs text-muted-foreground">
                {t("piSdkPublicUnsupported")}
              </p>
            ) : null}
            {rpcUrl && cardUrl ? (
              [
                [t("rpcUrl"), rpcUrl],
                [t("cardUrl"), cardUrl],
              ].map(([label, url]) => (
                <div key={label} className="min-w-0 rounded-lg bg-muted/40 p-3">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="text-xs font-medium">{label}</span>
                    <CopyButton text={url} label={t("copy")} />
                  </div>
                  <code className="block break-all text-xs">{url}</code>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("connectionUnavailable")}
              </p>
            )}
          </section>
          {view.canManage && view.endpoint ? (
            <section className={cardClass} aria-labelledby="a2a-keys-heading">
              <h3
                id="a2a-keys-heading"
                className="flex items-center gap-2 font-semibold"
              >
                <KeyRound className="size-4" />
                {t("credentials")}
              </h3>
              {!view.endpoint.clients.length ? (
                <p className="text-sm text-muted-foreground">
                  {t("noClients")}
                </p>
              ) : (
                view.endpoint.clients.map((client) => (
                  <div
                    key={client.id}
                    className="space-y-3 rounded-lg border border-border p-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="break-all text-sm font-medium">
                        {client.name}
                      </p>
                    </div>
                    {client.keys.map((key) => (
                      <div
                        key={key.id}
                        className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 text-xs"
                      >
                        <div>
                          <code>{key.prefix}</code>
                          <p className="mt-1 text-muted-foreground">
                            {t(
                              key.revokedAt
                                ? "revoked"
                                : key.expiresAt &&
                                    Date.parse(key.expiresAt) <= Date.now()
                                  ? "expired"
                                  : "activeKey",
                            )}
                          </p>
                        </div>
                        <Button
                          disabled={locked || !!key.revokedAt}
                          onClick={() => setRevokeKeyId(key.id)}
                          variant={"secondary"}
                          size={"sm"}
                        >
                          {t("revoke")}
                        </Button>
                      </div>
                    ))}
                  </div>
                ))
              )}
              <ConfirmActionDialog
                open={revokeKeyId !== null}
                title={t("revoke")}
                description={t("revokeConfirm")}
                confirmLabel={t("revoke")}
                cancelLabel={common("cancel")}
                busy={busy}
                onClose={() => setRevokeKeyId(null)}
                onConfirm={() => {
                  const targetId = revokeKeyId;
                  setRevokeKeyId(null);
                  if (targetId)
                    void mutate({
                      action: "revoke-key",
                      keyId: targetId,
                    });
                }}
              />
            </section>
          ) : null}
          {view.local.supported ? (
            <AgentA2ARemotes key={base} base={base} readOnly={!executable} />
          ) : null}
          {initialTaskId ? (
            <AgentA2ATaskMonitor
              key={initialTaskId}
              base={base}
              rootTaskId={initialTaskId}
              showHistory
              onRootState={() => {}}
            />
          ) : null}
        </>
      )}
      <footer className={cardClass}>
        <h3 className="flex items-center gap-2 font-semibold">
          <BookOpen className="size-4" />
          {t("docs")}
        </h3>
        <ButtonLink
          href="/docs-api"
          target="_blank"
          rel="noopener noreferrer"
          variant="secondary"
        >
          {t("docs")}
          <ArrowUpRight className="size-3" />
        </ButtonLink>
      </footer>
    </div>
  );
}
