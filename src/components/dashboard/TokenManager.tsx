"use client";
import { Button } from "@/components/motion/button";
import { Input } from "@/components/motion/input";

import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { KeyRound, Copy, Check, Trash2 } from "lucide-react";
import { createTokenAction, revokeTokenAction } from "@/lib/auth/actions";
import type { TokenState } from "@/lib/auth/actions";
import { DashboardEmptyState, DashboardPanel } from "./DashboardUI";

export type TokenView = {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  createdAt: string;
};

function CreateButton() {
  const t = useTranslations("console.tokens");
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} variant="primary" size="md">
      {pending ? t("creating") : t("createToken")}
    </Button>
  );
}

function NewTokenReveal({ token }: { token: string }) {
  const t = useTranslations("console.tokens");
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-md border border-border bg-muted p-3 border-border bg-muted">
      <p className="mb-2 text-xs font-medium text-(--color-success) dark:text-(--color-success)">
        {t("copyThisTokenNowYouWontBeAbleToSeeItAgain")}
      </p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-card px-2 py-1.5 font-mono text-sm text-foreground">
          {token}
        </code>
        <Button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(token).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          variant="secondary"
          size="sm"
          className="shrink-0"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          {copied ? t("copied") : t("copy")}
        </Button>
      </div>
    </div>
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
  const [state, formAction] = useActionState<TokenState, FormData>(
    createTokenAction,
    {},
  );

  return (
    <DashboardPanel
      title={t("tokens")}
      description={t(
        "personalBearerTokensForTheMcpGatewayAndJsonApiScopedToYourAccountNotThisWorkspace",
      )}
    >
      <div className="space-y-4">
        {state.token ? <NewTokenReveal token={state.token} /> : null}

        <form action={formAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="workspace" value={workspaceSlug} />
          <div className="flex-1 space-y-1.5">
            <label
              htmlFor="token-name"
              className="text-sm font-medium text-foreground"
            >
              {t("tokenName")}
            </label>
            <Input
              id="token-name"
              name="name"
              type="text"
              placeholder={t("egMyLaptop")}
            />
          </div>
          <CreateButton />
        </form>
        {state.error ? (
          <p
            className="text-sm text-destructive dark:text-destructive"
            role="alert"
          >
            {state.error}
          </p>
        ) : null}

        {tokens.length === 0 ? (
          <DashboardEmptyState
            icon={KeyRound}
            title={t("noTokensYet")}
            description={t("createOneAboveToConnectAnAgentOrCli")}
            className="min-h-48"
          />
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
            {tokens.map((token) => (
              <li
                key={token.id}
                className="flex items-center justify-between gap-3 px-3.5 py-3"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <KeyRound className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {token.name || t("untitledToken")}
                    </p>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {token.prefix}… ·{" "}
                      {token.lastUsedAt
                        ? `last used ${token.lastUsedAt}`
                        : t("neverUsed")}{" "}
                      {t("created")} {token.createdAt}
                    </p>
                  </div>
                </div>
                <form action={revokeTokenAction}>
                  <input type="hidden" name="id" value={token.id} />
                  <input type="hidden" name="workspace" value={workspaceSlug} />
                  <Button
                    type="submit"
                    variant="secondary"
                    size="sm"
                    className="inline-flex items-center"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> {t("revoke")}
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </div>
    </DashboardPanel>
  );
}
