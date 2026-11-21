"use client";

import { LogIn, Unlink } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { ConfirmSubmitButton } from "@/components/dashboard/ConfirmSubmitButton";
import { notify } from "@/components/dashboard/Toaster";
import {
  AnimatedBadge,
  type AnimatedBadgeStatus,
} from "@/components/motion/animated-badge";
import { ButtonLink } from "@/components/motion/button";
import { disconnectMcpOAuthAction } from "@/lib/remote-mcp/oauth-actions";
import type {
  McpOAuthConnectionStatus,
  McpOAuthConnectionSummary,
  McpOAuthOutcome,
} from "@/lib/remote-mcp/oauth-types";

const OAUTH_OUTCOMES: ReadonlySet<McpOAuthOutcome> = new Set([
  "connected",
  "oauthDenied",
  "oauthStateInvalid",
  "oauthClientMissing",
  "oauthDiscoveryFailed",
  "oauthExchangeFailed",
]);

function isMcpOAuthOutcome(value: string): value is McpOAuthOutcome {
  return OAUTH_OUTCOMES.has(value as McpOAuthOutcome);
}

const STATUS_TONE: Record<McpOAuthConnectionStatus, AnimatedBadgeStatus> = {
  active: "success",
  reauth_required: "warning",
  not_connected: "neutral",
};

export function McpOAuthConnectionPanel({
  workspace,
  deploymentId,
  summary,
}: {
  workspace: string;
  deploymentId: string;
  summary: McpOAuthConnectionSummary;
}) {
  const t = useTranslations("console.mcp");
  const common = useTranslations("common");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const handledOutcomeRef = useRef<string | null>(null);

  useEffect(() => {
    const outcome = searchParams.get("oauth");
    if (!outcome || handledOutcomeRef.current === outcome) return;
    handledOutcomeRef.current = outcome;

    if (isMcpOAuthOutcome(outcome)) {
      if (outcome === "connected") {
        notify(t("oauth.outcomes.connected"));
      } else {
        notify(t(`oauth.outcomes.${outcome}`), { severity: "error" });
      }
    }

    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.delete("oauth");
    const qs = nextParams.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [pathname, router, searchParams, t]);

  const handleDisconnect = async () => {
    try {
      const result = await disconnectMcpOAuthAction({
        workspace,
        deploymentId,
      });
      if (result.ok) {
        notify(t("oauth.disconnected"));
        router.refresh();
      } else {
        notify(t(`oauth.actionErrors.${result.error}`), { severity: "error" });
      }
    } catch {
      notify(t("oauth.actionErrors.operationFailed"), { severity: "error" });
    }
  };

  return (
    <section
      aria-label={t("oauth.title")}
      className="rounded-xl border border-border bg-card px-5 py-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="text-sm font-semibold text-foreground">
              {t("oauth.title")}
            </h2>
            <AnimatedBadge status={STATUS_TONE[summary.status]} size="sm">
              {t(`oauth.status.${summary.status}`)}
            </AnimatedBadge>
            {summary.accountLabel ? (
              <span className="truncate text-sm text-muted-foreground">
                {summary.accountLabel}
              </span>
            ) : null}
          </div>
          {summary.scopes.length > 0 ? (
            <p className="break-all font-mono text-xs text-muted-foreground">
              {summary.scopes.join(" ")}
            </p>
          ) : null}
        </div>

        {summary.status !== "not_connected" ? (
          <div className="flex flex-wrap items-center gap-2">
            {/* The page header owns the primary sign-in action while setup is required. */}
            {summary.status === "active" ? (
              <ButtonLink href={summary.startUrl} variant="secondary" size="sm">
                <LogIn className="size-3.5" aria-hidden="true" />
                {t("oauth.reSignIn")}
              </ButtonLink>
            ) : null}
            <form action={handleDisconnect}>
              <ConfirmSubmitButton
                triggerLabel={
                  <>
                    <Unlink className="size-3.5" aria-hidden="true" />
                    {t("oauth.disconnect")}
                  </>
                }
                confirmLabel={common("confirm")}
                cancelLabel={common("cancel")}
                prompt={t("oauth.disconnectConfirm")}
                pendingLabel={t("oauth.disconnecting")}
                className="items-center"
                triggerVariant="secondary"
                triggerSize="sm"
                confirmVariant="secondary"
                confirmSize="sm"
                cancelVariant="ghost"
                cancelSize="sm"
              />
            </form>
          </div>
        ) : null}
      </div>
    </section>
  );
}
