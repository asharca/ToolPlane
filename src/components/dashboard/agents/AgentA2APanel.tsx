"use client";
import { Button, ButtonLink } from "@/components/motion/button/base";

import { AnimatedBadge } from "@/components/motion/animated-badge";

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { useTranslations } from "next-intl";

import {
  ArrowUpRight,
  BookOpen,
  KeyRound,
  Network,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { AgentA2ARemotes } from "./AgentA2ARemotes";
import { AgentA2ATaskMonitor } from "./AgentA2ATaskMonitor";
import { CopyButton } from "@/components/dashboard/CopyButton";
import type { A2AConsoleView } from "@/lib/a2a/connection-info";
import type { A2AConsoleAction } from "@/lib/a2a/console-service";

const cardClass =
  "space-y-4 rounded-xl border border-border bg-background p-4 sm:p-5";

export function AgentA2APanel({
  slug,
  agentId,
  runtimeKind,
  initialTaskId,
}: {
  slug: string;
  agentId: string;
  runtimeKind: string;
  initialTaskId?: string;
}) {
  const t = useTranslations("console.agents.a2a");
  const [view, setView] = useState<A2AConsoleView | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"local" | "public">("local");
  const flight = useRef(false);
  const mounted = useRef(true);
  const base = `/api/v1/workspaces/${encodeURIComponent(slug)}/agents/${encodeURIComponent(agentId)}/a2a/console`;
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const response = await fetch(base, {
        cache: "no-store",
        credentials: "same-origin",
        signal,
      });
      if (!response.ok) throw new Error(t("loadFailed"));
      const next: A2AConsoleView = await response.json();
      if (mounted.current && !signal?.aborted) setView(next);
    },
    [base, t],
  );
  const loadInitial = useEffectEvent((signal: AbortSignal) => {
    void load(signal).catch(() => {
      if (!signal.aborted) setError(t("loadFailed"));
    });
  });
  useEffect(() => {
    void base; // Target identity alone controls the initial fetch lifecycle.
    mounted.current = true;
    const controller = new AbortController();
    loadInitial(controller.signal);
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
    setNotice("");
    try {
      await run();
    } catch {
      if (mounted.current) setError(t("operationFailed"));
    } finally {
      flight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function mutate(action: A2AConsoleAction) {
    await operation(async () => {
      const response = await fetch(base, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action),
      });
      if (!response.ok) throw new Error();
      if (!mounted.current) return;
      setNotice(t("saved"));
      try {
        await load();
      } catch {
        if (mounted.current) setError(t("refreshFailed"));
      }
    });
  }
  const connection = view?.connections;
  const rpcUrl =
    mode === "local" ? connection?.localRpc : connection?.publicRpc;
  const cardUrl =
    mode === "local" ? connection?.localCard : connection?.publicCard;
  const locked = busy || !view?.canManage;

  return (
    <div className="mx-auto max-w-4xl space-y-5 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Network className="size-5" />
            <h2 className="text-lg font-semibold">{t("title")}</h2>
            <AnimatedBadge>A2A 1.0</AnimatedBadge>
          </div>
          <p className="max-w-xl text-sm text-muted-foreground">
            {t("description")}
          </p>
        </div>
        <Button
          disabled={busy}
          onClick={() => void operation(() => load())}
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
      {notice ? (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
      {!view ? (
        <p role="status">{t("loading")}</p>
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
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-3 rounded-lg border border-border p-3">
                <h4 className="text-sm font-semibold">{t("inboundTitle")}</h4>
                <p className="text-sm text-muted-foreground">
                  {t("inboundDescription")}
                </p>
                <AnimatedBadge
                  status={
                    view.collaboration.inboundEnabled ? "success" : "neutral"
                  }
                >
                  {t(
                    view.collaboration.inboundEnabled ? "enabled" : "disabled",
                  )}
                </AnimatedBadge>
                <Button
                  disabled={
                    locked ||
                    (runtimeKind !== "pi-sdk" &&
                      !view.collaboration.inboundEnabled)
                  }
                  onClick={() =>
                    void mutate({
                      action: "set-inbound",
                      enabled: !view.collaboration.inboundEnabled,
                    })
                  }
                  variant={
                    view.collaboration.inboundEnabled ? "secondary" : "primary"
                  }
                  className="w-full"
                >
                  {t(
                    view.collaboration.inboundEnabled
                      ? "disableInbound"
                      : "enableInbound",
                  )}
                </Button>
              </div>
              <div className="space-y-3 rounded-lg border border-border p-3">
                <h4 className="text-sm font-semibold">{t("outboundTitle")}</h4>
                <p className="text-sm text-muted-foreground">
                  {t("outboundDescription")}
                </p>
                <AnimatedBadge
                  status={
                    view.collaboration.outboundEnabled ? "success" : "neutral"
                  }
                >
                  {t(
                    view.collaboration.outboundEnabled ? "enabled" : "disabled",
                  )}
                </AnimatedBadge>
                <Button
                  disabled={
                    locked ||
                    (runtimeKind !== "pi-sdk" &&
                      !view.collaboration.outboundEnabled)
                  }
                  onClick={() =>
                    void mutate({
                      action: "set-outbound",
                      enabled: !view.collaboration.outboundEnabled,
                    })
                  }
                  variant={
                    view.collaboration.outboundEnabled ? "secondary" : "primary"
                  }
                  className="w-full"
                >
                  {t(
                    view.collaboration.outboundEnabled
                      ? "disableOutbound"
                      : "enableOutbound",
                  )}
                </Button>
              </div>
            </div>
          </section>
          <section className={cardClass} aria-labelledby="a2a-internal-heading">
            <h3 id="a2a-internal-heading" className="font-semibold">
              {t("internalTitle")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("internalDescription")}
            </p>
            <p className="text-sm text-muted-foreground">
              {t("authorizedTargetsOnly")}
            </p>
            <p className="text-sm text-muted-foreground">
              {t("sandboxWarning")}
            </p>
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
            <a
              className="text-sm underline underline-offset-4"
              href="?settings=subAgents"
            >
              {t("configureTargets")}
            </a>
          </section>
          <section
            className={cardClass}
            aria-label={t("channelOperator.title")}
          >
            {view.canManage && view.channels?.length ? (
              <section
                className={cardClass}
                aria-labelledby="a2a-channel-operator-heading"
              >
                <h3 id="a2a-channel-operator-heading" className="font-semibold">
                  {t("channelOperator.title")}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {t("channelOperator.hint")}
                </p>
                {view.channels.map((channel) => (
                  <div
                    key={channel.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3"
                  >
                    <span className="text-sm">
                      {channel.name} · {channel.platform}
                    </span>
                    <Button
                      type="button"
                      disabled={
                        busy ||
                        (!channel.enabled && !view.collaboration.inboundEnabled)
                      }
                      onClick={() => {
                        if (window.confirm(t("channelOperator.confirm")))
                          void mutate({
                            action: "set-channel-operator",
                            connectionId: channel.id,
                            enabled: !channel.enabled,
                          });
                      }}
                      variant={"secondary"}
                      size={"sm"}
                    >
                      {t(
                        channel.enabled
                          ? "channelOperator.disable"
                          : "channelOperator.enable",
                      )}
                    </Button>
                  </div>
                ))}
              </section>
            ) : null}
          </section>
          {view.local.supported ? (
            <AgentA2ARemotes key={base} base={base} />
          ) : null}
          {runtimeKind === "hermes" ? (
            <section className={cardClass} aria-labelledby="a2a-public-heading">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 id="a2a-public-heading" className="font-semibold">
                    {t("publicTitle")}
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t("publicDescription")}
                  </p>
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
          {runtimeKind === "pi-sdk" ? (
            <p className={`${cardClass} text-sm text-muted-foreground`}>
              {t("piSdkPublicUnsupported")}
            </p>
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
            {runtimeKind === "hermes" ? (
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
          {runtimeKind === "hermes" && view.canManage && view.endpoint ? (
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
                          disabled={busy || !!key.revokedAt}
                          onClick={() => {
                            if (window.confirm(t("revokeConfirm")))
                              void mutate({
                                action: "revoke-key",
                                keyId: key.id,
                              });
                          }}
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
            </section>
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
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <ShieldCheck className="size-4 shrink-0" />
          {t("boundaries")}
        </p>
      </footer>
    </div>
  );
}
