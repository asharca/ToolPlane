"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Check, Copy, Eye, EyeOff, KeyRound, Trash2 } from "lucide-react";
import { ActionSwapButton } from "@/components/motion/action-swap";
import {
  Alert,
  AlertContent,
  AlertDescription,
  AlertIcon,
  AlertTitle,
} from "@/components/motion/alert";
import { Button } from "@/components/motion/button";
import { DigitSwap } from "@/components/motion/digit-swap";
import { Input } from "@/components/motion/input";
import { createTokenAction, revokeTokenAction } from "@/lib/auth/actions";
import type { TokenState } from "@/lib/auth/actions";
import { copyText } from "./CopyButton";
import { ConfirmSubmitButton } from "./ConfirmSubmitButton";
import { DashboardEmptyState, DashboardPanel } from "./DashboardUI";
import { SubmitButton } from "./SubmitButton";
import { DialogField } from "./dialog";

export type TokenView = {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  createdAt: string;
};

function maskSecretToken(token: string) {
  if (token.length <= 4) return "•".repeat(token.length);
  return `${"•".repeat(Math.min(token.length - 4, 20))}${token.slice(-4)}`;
}

function CreateButton() {
  const t = useTranslations("console.tokens");
  return (
    <SubmitButton
      pendingLabel={t("creating")}
      flash={false}
      variant="primary"
      size="md"
    >
      {t("createToken")}
    </SubmitButton>
  );
}

function NewTokenReveal({ token }: { token: string }) {
  const t = useTranslations("console.tokens");
  const commonT = useTranslations("console.common");
  const [revealed, setRevealed] = useState(true);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  async function handleCopy() {
    if (!(await copyText(token))) return;
    setCopied(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Alert variant="success" className="border border-border">
      <AlertIcon />
      <AlertContent>
        <AlertTitle className="text-xs font-medium">
          {t("copyThisTokenNowYouWontBeAbleToSeeItAgain")}
        </AlertTitle>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-border bg-card px-2.5 py-1.5 text-foreground">
            <DigitSwap
              value={revealed ? token : maskSecretToken(token)}
              animationKey={revealed ? "revealed" : "masked"}
              direction={revealed ? "up" : "down"}
              suffixLength={4}
              glyphClassName={
                revealed ? "text-foreground" : "text-muted-foreground"
              }
              suffixClassName="text-foreground"
              className="font-mono text-xs sm:text-sm"
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={revealed ? commonT("hideValue") : commonT("showValue")}
            aria-pressed={!revealed}
            onClick={() => setRevealed((current) => !current)}
            className="shrink-0"
          >
            {revealed ? (
              <EyeOff className="size-4" aria-hidden="true" />
            ) : (
              <Eye className="size-4" aria-hidden="true" />
            )}
          </Button>
          <ActionSwapButton
            type="button"
            variant="secondary"
            size="sm"
            animation="blur"
            cycle={false}
            value={copied ? "copied" : "copy"}
            onClick={() => void handleCopy()}
            className="shrink-0"
            items={[
              {
                id: "copy",
                label: t("copy"),
                icon: <Copy className="size-3.5" aria-hidden="true" />,
              },
              {
                id: "copied",
                label: t("copied"),
                icon: <Check className="size-3.5" aria-hidden="true" />,
              },
            ]}
          />
        </div>
      </AlertContent>
    </Alert>
  );
}

export function TokenManager({
  tokens,
  workspaceSlug = "",
}: {
  tokens: TokenView[];
  workspaceSlug?: string;
}) {
  const t = useTranslations("console.tokens");
  const commonT = useTranslations("console.common");
  const [state, formAction] = useActionState<TokenState, FormData>(
    createTokenAction,
    {},
  );
  const [tokenName, setTokenName] = useState("");
  const [savedName, setSavedName] = useState("");
  const [createdToken, setCreatedToken] = useState(state.token);
  if (createdToken !== state.token) {
    // A newly created token commits the typed name as the clean baseline.
    setCreatedToken(state.token);
    if (state.token) setSavedName(tokenName);
  }

  return (
    <DashboardPanel
      title={t("tokens")}
      description={t(
        "personalBearerTokensForTheMcpGatewayAndJsonApiScopedToYourAccountNotThisWorkspace",
      )}
    >
      <div className="space-y-4">
        {state.token ? (
          <NewTokenReveal key={state.token} token={state.token} />
        ) : null}

        <form action={formAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="workspace" value={workspaceSlug} />
          <DialogField
            label={t("tokenName")}
            htmlFor="token-name"
            dirty={tokenName !== savedName}
            className="min-w-0 flex-1 sm:max-w-sm"
          >
            <Input
              id="token-name"
              name="name"
              type="text"
              value={tokenName}
              onChange={setTokenName}
              placeholder={t("egMyLaptop")}
            />
          </DialogField>
          <CreateButton />
        </form>
        {state.error ? (
          <Alert variant="destructive">
            <AlertIcon />
            <AlertContent>
              <AlertDescription>{state.error}</AlertDescription>
            </AlertContent>
          </Alert>
        ) : null}

        {tokens.length === 0 ? (
          <DashboardEmptyState
            icon={KeyRound}
            title={t("noTokensYet")}
            description={t("createOneAboveToConnectAnAgentOrCli")}
            className="min-h-28"
          />
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
            {tokens.map((token) => (
              <li
                key={token.id}
                className="flex items-center justify-between gap-3 px-3.5 py-3"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <KeyRound className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {token.name || t("untitledToken")}
                    </p>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {token.prefix}… · {token.lastUsedAt ?? t("neverUsed")} ·{" "}
                      {t("created")} {token.createdAt}
                    </p>
                  </div>
                </div>
                <form action={revokeTokenAction}>
                  <input type="hidden" name="id" value={token.id} />
                  <input type="hidden" name="workspace" value={workspaceSlug} />
                  <ConfirmSubmitButton
                    triggerLabel={
                      <>
                        <Trash2 className="h-3.5 w-3.5" /> {t("revoke")}
                      </>
                    }
                    confirmLabel={t("revoke")}
                    cancelLabel={commonT("close")}
                    prompt={`${t("revoke")}?`}
                    triggerSize="sm"
                    confirmClassName="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  />
                </form>
              </li>
            ))}
          </ul>
        )}
      </div>
    </DashboardPanel>
  );
}
