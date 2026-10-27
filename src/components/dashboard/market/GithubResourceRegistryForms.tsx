"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/motion/input";
import { FormSelect } from "@/components/ui/FormSelect";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import {
  createGithubResourceRegistryAction,
  getGithubResourceRegistryWebhookAction,
  syncGithubResourceRegistryAction,
  updateGithubResourceRegistryCredentialsAction,
} from "@/lib/market/github-registry-actions";

function RegistryResult({
  state,
}: {
  state: { error?: string; success?: string };
}) {
  const t = useTranslations("console.market.githubRegistry");
  if (state.error) {
    const key = `errors.${state.error}`;
    return (
      <p role="alert" className="text-sm text-destructive">
        {t.has(key) ? t(key) : t("errors.action_failed")}
      </p>
    );
  }
  return state.success ? (
    <p role="status" className="text-sm text-muted-foreground">
      {t("syncRequested")}
    </p>
  ) : null;
}

export function GithubResourceRegistryForm({
  workspace,
}: {
  workspace: string;
}) {
  const t = useTranslations("console.market.githubRegistry");
  const [state, action, pending] = useActionState(
    createGithubResourceRegistryAction,
    {},
  );
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="workspace" value={workspace} />
      <fieldset disabled={pending} className="min-w-0 space-y-4">
        <Input label={t("name")} name="name" required maxLength={100} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label={t("repository")}
            name="repository"
            defaultValue="asharca/toolplane-resources"
            required
            maxLength={200}
            autoComplete="off"
          />
          <Input
            label={t("branch")}
            name="branch"
            defaultValue="main"
            required
            maxLength={240}
          />
        </div>
        <FormSelect
          name="visibility"
          label={t("visibility")}
          defaultValue="private"
          options={[
            { value: "private", label: t("private") },
            { value: "public", label: t("public") },
          ]}
        />
        <p className="text-sm text-muted-foreground">{t("visibilityHelp")}</p>
        <Input
          label={t("token")}
          type="password"
          name="token"
          autoComplete="new-password"
          maxLength={4096}
        />
        <p className="text-sm text-muted-foreground">{t("credentialsHelp")}</p>
        <SubmitButton
          variant="primary"
          size="md"
          pendingLabel={t("working")}
          error={state.error}
        >
          {t("add")}
        </SubmitButton>
      </fieldset>
      <RegistryResult state={state} />
    </form>
  );
}

export function GithubResourceRegistrySyncForm({
  workspace,
  registryId,
  disabled = false,
}: {
  workspace: string;
  registryId: string;
  disabled?: boolean;
}) {
  const t = useTranslations("console.market.githubRegistry");
  const [state, action] = useActionState(syncGithubResourceRegistryAction, {});
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="workspace" value={workspace} />
      <input type="hidden" name="registryId" value={registryId} />
      <SubmitButton
        variant="secondary"
        size="sm"
        pendingLabel={t("working")}
        disabled={disabled}
        error={state.error}
      >
        {t("sync")}
      </SubmitButton>
      <RegistryResult state={state} />
    </form>
  );
}

export function GithubResourceRegistryCredentialsForm({
  workspace,
  registryId,
}: {
  workspace: string;
  registryId: string;
}) {
  const t = useTranslations("console.market.githubRegistry");
  const [state, action] = useActionState(
    updateGithubResourceRegistryCredentialsAction,
    {},
  );
  return (
    <details className="space-y-3 text-sm">
      <summary className="cursor-pointer font-medium">
        {t("replaceCredentials")}
      </summary>
      <form action={action} className="max-w-xl space-y-3">
        <input type="hidden" name="workspace" value={workspace} />
        <input type="hidden" name="registryId" value={registryId} />
        <Input
          label={t("token")}
          type="password"
          name="token"
          autoComplete="new-password"
          required
          maxLength={4096}
        />
        <p className="text-sm text-muted-foreground">{t("credentialsHelp")}</p>
        <SubmitButton
          variant="secondary"
          size="sm"
          pendingLabel={t("working")}
          error={state.error}
        >
          {t("replaceCredentials")}
        </SubmitButton>
        <RegistryResult state={state} />
      </form>
    </details>
  );
}

export function GithubResourceRegistryWebhookForm({
  workspace,
  registryId,
}: {
  workspace: string;
  registryId: string;
}) {
  const t = useTranslations("console.market.githubRegistry");
  const [state, action] = useActionState(
    getGithubResourceRegistryWebhookAction,
    {},
  );
  return (
    <form action={action} className="max-w-xl space-y-3">
      <input type="hidden" name="workspace" value={workspace} />
      <input type="hidden" name="registryId" value={registryId} />
      <SubmitButton
        variant="secondary"
        size="sm"
        pendingLabel={t("working")}
        error={state.error}
      >
        {t("getWebhookConfiguration")}
      </SubmitButton>
      <RegistryResult state={state} />
      {state.webhook ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{t("webhookHelp")}</p>
          <Input
            label={t("webhookEndpoint")}
            value={`${window.location.origin}${state.webhook.path}`}
            readOnly
            autoComplete="off"
          />
          <Input
            label={t("webhookSecret")}
            value={state.webhook.secret}
            readOnly
            autoComplete="off"
          />
          <p className="text-sm text-muted-foreground">
            {t("webhookSecretHelp")}
          </p>
        </div>
      ) : null}
    </form>
  );
}
