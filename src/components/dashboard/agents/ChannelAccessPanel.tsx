"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/motion/button/base";
import { notify } from "@/components/dashboard/Toaster";
import { RelativeTime } from "@/components/observability/LogPrimitives";

export type ChannelAccessCommand = {
  action: "approvePairing" | "dismissPairing" | "allowSender" | "revokeSender";
  connectionId: string;
  requestId?: string;
  platformUserId?: string;
  userName?: string;
};

type AccessData = {
  pending: Array<{
    id: string;
    platformUserId: string;
    userName?: string | null;
    chatId: string;
    code: string;
    createdAt: string;
    expiresAt: string;
  }>;
  approved: Array<{
    platformUserId: string;
    userName?: string | null;
    createdAt: string;
    approvedBy: { name: string | null; email: string } | null;
  }>;
  rejected: Array<{
    platformUserId: string;
    userName?: string | null;
    chatId?: string | null;
    chatType?: string | null;
    rule: string;
    count: number;
    lastAt: string;
  }>;
};

export function ChannelAccessPanel({
  endpoint,
  connectionId,
  pending,
  send,
}: {
  endpoint: string;
  connectionId: string;
  pending: boolean;
  send: (command: ChannelAccessCommand) => Promise<unknown | null>;
}) {
  const t = useTranslations("console.agentMessaging");
  const locale = useLocale();
  const requestFailed = t("requestFailed");
  const [data, setData] = useState<AccessData | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const revision = useRef(0);
  const mutating = useRef(false);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  useEffect(() => {
    void reload;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let active = false;
    async function refresh() {
      if (active || controller.signal.aborted) return;
      clearTimeout(timer);
      active = true;
      const version = revision.current;
      try {
        if (!document.hidden && !pendingRef.current && !mutating.current) {
          const response = await fetch(
            `${endpoint}?access=${encodeURIComponent(connectionId)}`,
            { cache: "no-store", signal: controller.signal },
          );
          const snapshot = (await response.json()) as AccessData & {
            error?: string;
          };
          if (!response.ok) throw new Error(snapshot.error || requestFailed);
          if (!controller.signal.aborted && version === revision.current) {
            setData(snapshot);
            setError("");
          }
        }
      } catch (cause) {
        if (!controller.signal.aborted && version === revision.current)
          setError(cause instanceof Error ? cause.message : requestFailed);
      } finally {
        active = false;
        if (!controller.signal.aborted) timer = setTimeout(refresh, 3000);
      }
    }
    void refresh();
    document.addEventListener("visibilitychange", refresh);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [connectionId, endpoint, reload, requestFailed]);

  async function act(command: Omit<ChannelAccessCommand, "connectionId">) {
    if (mutating.current || pendingRef.current) return;
    revision.current += 1;
    mutating.current = true;
    try {
      const result = await send({ ...command, connectionId });
      if (result) {
        notify(
          t(
            {
              approvePairing: "pairingApproved",
              dismissPairing: "pairingDismissed",
              allowSender: "senderAllowed",
              revokeSender: "senderRevoked",
            }[command.action],
          ),
        );
        setError("");
      } else {
        notify(requestFailed, { severity: "error" });
      }
    } finally {
      mutating.current = false;
      setReload((value) => value + 1);
    }
  }

  const sender = (entry: {
    platformUserId: string;
    userName?: string | null;
  }) => (
    <p className="break-words text-sm font-medium">
      {entry.userName ? (
        <>
          {entry.userName}{" "}
          <span className="font-mono text-xs text-muted-foreground">
            ({entry.platformUserId})
          </span>
        </>
      ) : (
        entry.platformUserId
      )}
    </p>
  );
  return (
    <section
      className="space-y-5 border-t border-border pt-4"
      aria-label={t("access")}
    >
      {error && (
        <p role="alert" className="break-words text-sm text-destructive">
          {error}
        </p>
      )}
      {!data && !error && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("accessLoading")}
        </p>
      )}
      {data && (
        <>
          <section className="space-y-3">
            <h3 className="text-sm font-medium">{t("pendingPairings")}</h3>
            {!data.pending.length && (
              <p className="text-sm text-muted-foreground">
                {t("noPendingPairings")}
              </p>
            )}
            <ul className="divide-y divide-border">
              {data.pending.map((entry) => (
                <li key={entry.id} className="space-y-2 py-3">
                  {sender(entry)}
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <code className="rounded-lg bg-muted px-2 py-1 font-mono tracking-wider">
                      {entry.code}
                    </code>
                    <span className="text-muted-foreground">
                      {t("pairingExpires", {
                        // Browser-local like RelativeTime; the intl provider formats in the server time zone.
                        time: new Date(entry.expiresAt).toLocaleString(locale, {
                          dateStyle: "short",
                          timeStyle: "short",
                        }),
                      })}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="primary"
                      disabled={
                        pending || Date.parse(entry.expiresAt) <= Date.now()
                      }
                      onClick={() =>
                        void act({
                          action: "approvePairing",
                          requestId: entry.id,
                        })
                      }
                    >
                      {t("approvePairing")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() =>
                        void act({
                          action: "dismissPairing",
                          requestId: entry.id,
                        })
                      }
                    >
                      {t("dismissPairing")}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
          <section className="space-y-3 border-t border-border pt-4">
            <h3 className="text-sm font-medium">{t("approvedSenders")}</h3>
            {!data.approved.length && (
              <p className="text-sm text-muted-foreground">
                {t("noApprovedSenders")}
              </p>
            )}
            <ul className="divide-y divide-border">
              {data.approved.map((entry) => (
                <li
                  key={entry.platformUserId}
                  className="flex flex-wrap items-center justify-between gap-2 py-3"
                >
                  <div className="min-w-0 flex-1">{sender(entry)}</div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() =>
                      void act({
                        action: "revokeSender",
                        platformUserId: entry.platformUserId,
                      })
                    }
                  >
                    {t("revokeSender")}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
          <section className="space-y-3 border-t border-border pt-4">
            <h3 className="text-sm font-medium">{t("rejectedSenders")}</h3>
            {!data.rejected.length && (
              <p className="text-sm text-muted-foreground">
                {t("noRejectedSenders")}
              </p>
            )}
            <ul className="divide-y divide-border">
              {data.rejected.map((entry) => (
                <li
                  key={entry.platformUserId}
                  className="flex flex-wrap items-center justify-between gap-2 py-3"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    {sender(entry)}
                    <p className="break-words text-xs text-muted-foreground">
                      {t.has(`rejectionRules.${entry.rule}`)
                        ? t(`rejectionRules.${entry.rule}`)
                        : t("rejectionUnknown")}
                      {" · "}
                      {t("rejectedCount", { count: entry.count })}
                      {" · "}
                      <RelativeTime value={entry.lastAt} />
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={pending}
                    onClick={() =>
                      void act({
                        action: "allowSender",
                        platformUserId: entry.platformUserId,
                        ...(entry.userName ? { userName: entry.userName } : {}),
                      })
                    }
                  >
                    {t("allowSender")}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </section>
  );
}
