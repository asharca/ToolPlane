"use client";
import { Button } from "@/components/motion/button/base";
import { Input } from "@/components/motion/input";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { BouncyAccordion } from "@/components/motion/bouncy-accordion";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { useTranslations } from "next-intl";

import type {
  RemoteAgentAction,
  RemoteAgentView,
} from "@/lib/a2a/remote-registry";

export function AgentA2ARemotes({ base }: { base: string }) {
  const t = useTranslations("console.agents.a2a.remote");
  const [view, setView] = useState<RemoteAgentView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [cardUrl, setCardUrl] = useState("");
  const [rpcUrl, setRpcUrl] = useState("");
  const [token, setToken] = useState("");
  const [keyTarget, setKeyTarget] = useState<string | null>(null);
  const mounted = useRef(true),
    flight = useRef(false),
    generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const endpoint = `${base}/remotes`;
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const current = ++generation.current;
      const response = await fetch(endpoint, {
        cache: "no-store",
        credentials: "same-origin",
        signal: AbortSignal.any([
          AbortSignal.timeout(15_000),
          ...(signal ? [signal] : []),
        ]),
      });
      if (!response.ok) throw new Error();
      const next: RemoteAgentView = await response.json();
      if (!Array.isArray(next.agents) || typeof next.canManage !== "boolean")
        throw new Error();
      if (mounted.current && current === generation.current && !signal?.aborted)
        setView(next);
    },
    [endpoint],
  );
  const loadInitial = useEffectEvent((signal: AbortSignal) => {
    void load(signal).catch(() => {
      if (!signal.aborted) setError(t("failed"));
    });
  });
  useEffect(() => {
    void endpoint; // Target identity alone controls the initial fetch lifecycle.
    mounted.current = true;
    const abort = new AbortController();
    loadInitial(abort.signal);
    return () => {
      mounted.current = false;
      abort.abort();
      controller.current?.abort();
    };
  }, [endpoint]);
  useEffect(() => {
    const clear = () => {
      if (document.hidden) setToken("");
    };
    document.addEventListener("visibilitychange", clear);
    const timer = token ? setTimeout(() => setToken(""), 180_000) : undefined;
    return () => {
      document.removeEventListener("visibilitychange", clear);
      if (timer) clearTimeout(timer);
    };
  }, [token]);
  async function mutate(action: RemoteAgentAction) {
    if (flight.current || !window.confirm(t("confirm"))) return;
    flight.current = true;
    setBusy(true);
    setError("");
    controller.current = new AbortController();
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action),
        signal: AbortSignal.any([
          controller.current.signal,
          AbortSignal.timeout(25_000),
        ]),
      });
      if (!response.ok) {
        const value = await response.json();
        // Only the BFF's fixed, sanitized policy messages are returned here; never native network exceptions.
        throw new Error(
          typeof value.error === "string" ? value.error : t("failed"),
        );
      }
      if (!mounted.current) return;
      setToken("");
      setKeyTarget(null);
      if (action.action === "register") {
        setName("");
        setCardUrl("");
        setRpcUrl("");
      }
      await load();
    } catch (failure) {
      if (mounted.current)
        setError(
          failure instanceof Error && failure.message
            ? failure.message
            : t("failed"),
        );
    } finally {
      flight.current = false;
      if (mounted.current) {
        setBusy(false);
        setToken("");
      }
    }
  }
  return (
    <section
      className="space-y-4 rounded-xl border border-border bg-background p-4 sm:p-5"
      aria-labelledby="a2a-remotes-title"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 id="a2a-remotes-title" className="font-semibold">
          {t("title")}
        </h3>
        <Button
          disabled={busy}
          onClick={() => {
            setError("");
            void load().catch(() => {
              if (mounted.current) setError(t("failed"));
            });
          }}
          variant={"secondary"}
          size={"sm"}
        >
          {t("refresh")}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{t("boundary")}</p>
      <p className="text-xs text-muted-foreground">{t("allowlist")}</p>
      {error ? (
        <div role="alert" className="space-y-2 text-sm text-muted-foreground">
          {error}
        </div>
      ) : null}
      {view?.canManage ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="text-sm">
            <Input
              label={t("card")}
              value={cardUrl}
              maxLength={2000}
              placeholder="https://agent.example/.well-known/agent-card.json"
              onChange={(value) => setCardUrl(value)}
            />
          </div>
          <div className="text-sm">
            <Input
              label={keyTarget ? t("replacementKey") : t("token")}
              type="password"
              autoComplete="off"
              value={token}
              maxLength={8192}
              onChange={(value) => setToken(value)}
            />
          </div>
          <div className="sm:col-span-2">
            <BouncyAccordion
              items={[
                {
                  id: "advanced",
                  title: t("advanced"),
                  description: (
                    <div className="grid gap-3 pt-3 sm:grid-cols-2">
                      <Input
                        label={t("name")}
                        value={name}
                        maxLength={100}
                        onChange={setName}
                      />
                      <Input
                        label={t("rpc")}
                        value={rpcUrl}
                        maxLength={2000}
                        placeholder="https://agent.example/a2a"
                        onChange={setRpcUrl}
                      />
                      <p className="text-xs text-muted-foreground sm:col-span-2">
                        {t("advancedHint")}
                      </p>
                    </div>
                  ),
                },
              ]}
            />
          </div>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button
              disabled={busy || !!keyTarget || !cardUrl.trim()}
              onClick={() =>
                void mutate({
                  action: "register",
                  cardUrl: cardUrl.trim(),
                  ...(token ? { token } : {}),
                  ...(name.trim() ? { name: name.trim() } : {}),
                  ...(rpcUrl.trim() ? { rpcUrl: rpcUrl.trim() } : {}),
                })
              }
              variant={"primary"}
            >
              {t("register")}
            </Button>
            {keyTarget ? (
              <>
                <Button
                  disabled={busy || !token}
                  onClick={() => {
                    const target = view.agents.find(
                      (row) => row.id === keyTarget,
                    );
                    if (target)
                      void mutate({
                        action: "replace-key",
                        id: target.id,
                        revision: target.revision,
                        token,
                      });
                  }}
                  variant={"ghost"}
                >
                  {t("saveKey")}
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => {
                    setKeyTarget(null);
                    setToken("");
                  }}
                  variant={"secondary"}
                >
                  {t("dismiss")}
                </Button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
      {view?.agents.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : null}
      <div className="space-y-3">
        {view?.agents.map((remote) => (
          <div
            key={remote.id}
            className="space-y-2 rounded-lg border border-border p-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <strong className="text-sm">{remote.name}</strong>
              <AnimatedBadge>
                {t(remote.enabled ? "enabled" : "disabled")}
              </AnimatedBadge>
              <AnimatedBadge>
                {t(remote.allowed ? "allowed" : "denied")}
              </AnimatedBadge>
            </div>
            <code className="block break-all text-xs text-muted-foreground">
              {remote.rpcUrl}
            </code>
            <code className="block break-all text-xs">{remote.id}</code>
            {view.canManage ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={busy}
                  onClick={() =>
                    void mutate({
                      action: "configure",
                      id: remote.id,
                      revision: remote.revision,
                      enabled: !remote.enabled,
                    })
                  }
                  variant={"secondary"}
                  size={"sm"}
                >
                  {t(remote.enabled ? "disable" : "enable")}
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void mutate({
                      action: "configure",
                      id: remote.id,
                      revision: remote.revision,
                      allowCurrentAgent: !remote.allowed,
                    })
                  }
                  variant={"secondary"}
                  size={"sm"}
                >
                  {t(remote.allowed ? "revoke" : "allow")}
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => {
                    setToken("");
                    setKeyTarget(remote.id);
                  }}
                  variant={"secondary"}
                  size={"sm"}
                >
                  {t("replaceKey")}
                </Button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{t("workflow")}</p>
    </section>
  );
}
