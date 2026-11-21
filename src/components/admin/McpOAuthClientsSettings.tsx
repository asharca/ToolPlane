"use client";

import { Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type FormEvent, useId, useState } from "react";
import { AdminBadge, AdminPanel } from "@/components/admin/AdminUI";
import { ConfirmSubmitButton } from "@/components/dashboard/ConfirmSubmitButton";
import { CopyButton } from "@/components/dashboard/CopyButton";
import { notify } from "@/components/dashboard/Toaster";
import { StatefulButton } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import { FormSelect } from "@/components/ui/FormSelect";
import {
  deleteMcpOAuthClientAction,
  saveMcpOAuthClientAction,
} from "@/lib/admin/mcp-oauth-client-actions";
import type {
  McpOAuthAdminOverview,
  McpOAuthClientAuthMethod,
} from "@/lib/remote-mcp/oauth-types";

export function McpOAuthClientsSettings({
  overview,
}: {
  overview: McpOAuthAdminOverview;
}) {
  const t = useTranslations("admin");
  const common = useTranslations("common");
  const router = useRouter();
  const baseId = useId();

  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [authMethod, setAuthMethod] =
    useState<McpOAuthClientAuthMethod>("client_secret_post");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const authMethodOptions: Array<{
    value: McpOAuthClientAuthMethod;
    label: string;
  }> = [
    {
      value: "client_secret_post",
      label: t("mcpOAuthAuthMethod_client_secret_post"),
    },
    {
      value: "client_secret_basic",
      label: t("mcpOAuthAuthMethod_client_secret_basic"),
    },
    { value: "none", label: t("mcpOAuthAuthMethod_none") },
  ];

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setFormError(null);
    try {
      const result = await saveMcpOAuthClientAction({
        issuer,
        clientId,
        clientSecret: clientSecret || undefined,
        authMethod,
      });
      if (result.ok) {
        setIssuer("");
        setClientId("");
        setClientSecret("");
        setAuthMethod("client_secret_post");
        notify(t("mcpOAuthClientSaved"));
        router.refresh();
      } else {
        const message = t(`mcpOAuthErrors.${result.error}`);
        setFormError(message);
        notify(message, { severity: "error" });
      }
    } catch {
      const message = t("mcpOAuthErrors.operationFailed");
      setFormError(message);
      notify(message, { severity: "error" });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const result = await deleteMcpOAuthClientAction({ id });
      if (result.ok) {
        notify(t("mcpOAuthClientDeleted"));
        router.refresh();
      } else {
        notify(t(`mcpOAuthErrors.${result.error}`), { severity: "error" });
      }
    } catch {
      notify(t("mcpOAuthErrors.operationFailed"), { severity: "error" });
    }
  };

  return (
    <AdminPanel title={t("mcpOAuthClients")}>
      <div className="space-y-6">
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="text-xs font-medium text-muted-foreground">
              {t("mcpOAuthRedirectUri")}
            </dt>
            <dd className="mt-1 flex min-w-0 items-center gap-2 rounded-lg border border-border bg-muted/40 py-1 pr-1 pl-3">
              <code
                title={overview.redirectUri}
                className="min-w-0 flex-1 truncate font-mono text-xs text-foreground"
              >
                {overview.redirectUri}
              </code>
              <CopyButton text={overview.redirectUri} />
            </dd>
          </div>
          {overview.clientMetadataUrl ? (
            <div>
              <dt className="text-xs font-medium text-muted-foreground">
                {t("mcpOAuthClientMetadataUrl")}
              </dt>
              <dd className="mt-1 flex min-w-0 items-center gap-2 rounded-lg border border-border bg-muted/40 py-1 pr-1 pl-3">
                <code
                  title={overview.clientMetadataUrl}
                  className="min-w-0 flex-1 truncate font-mono text-xs text-foreground"
                >
                  {overview.clientMetadataUrl}
                </code>
                <CopyButton text={overview.clientMetadataUrl} />
              </dd>
            </div>
          ) : null}
        </dl>

        {overview.clients.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("mcpOAuthNoClients")}
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border bg-card">
            {overview.clients.map((client) => (
              <li
                key={client.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="break-all font-mono text-sm font-medium text-foreground">
                      {client.issuer}
                    </span>
                    <AdminBadge
                      tone={client.source === "manual" ? "info" : "neutral"}
                    >
                      {client.source === "manual"
                        ? t("mcpOAuthSourceManual")
                        : t("mcpOAuthSourceDynamic")}
                    </AdminBadge>
                    <AdminBadge tone="neutral">
                      {client.hasSecret
                        ? t("mcpOAuthHasSecret")
                        : t("mcpOAuthNoSecret")}
                    </AdminBadge>
                  </div>
                  <p className="break-all font-mono text-xs text-muted-foreground">
                    {client.clientId}
                  </p>
                </div>

                <form action={() => handleDelete(client.id)}>
                  <ConfirmSubmitButton
                    triggerLabel={
                      <>
                        <Trash2 className="size-3.5" aria-hidden="true" />
                        {common("delete")}
                      </>
                    }
                    confirmLabel={common("confirm")}
                    cancelLabel={common("cancel")}
                    prompt={t("mcpOAuthDeleteConfirm", {
                      issuer: client.issuer,
                    })}
                    pendingLabel={`${common("delete")}…`}
                    className="items-center"
                    triggerVariant="ghost"
                    triggerSize="sm"
                    confirmVariant="secondary"
                    confirmSize="sm"
                    cancelVariant="ghost"
                    cancelSize="sm"
                  />
                </form>
              </li>
            ))}
          </ul>
        )}

        <form
          onSubmit={handleSave}
          className="space-y-4 rounded-xl border border-border bg-muted/20 p-4"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label
                htmlFor={`${baseId}-issuer`}
                className="block text-sm font-medium text-foreground"
              >
                {t("mcpOAuthIssuer")}
              </label>
              <Input
                id={`${baseId}-issuer`}
                type="url"
                value={issuer}
                onChange={setIssuer}
                placeholder="https://accounts.google.com"
                disabled={saving}
                required
                spellCheck={false}
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor={`${baseId}-client-id`}
                className="block text-sm font-medium text-foreground"
              >
                {t("mcpOAuthClientId")}
              </label>
              <Input
                id={`${baseId}-client-id`}
                type="text"
                value={clientId}
                onChange={setClientId}
                disabled={saving}
                required
                spellCheck={false}
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor={`${baseId}-client-secret`}
                className="block text-sm font-medium text-foreground"
              >
                {t("mcpOAuthClientSecret")}
              </label>
              <Input
                id={`${baseId}-client-secret`}
                type="password"
                value={clientSecret}
                onChange={setClientSecret}
                disabled={saving}
                autoComplete="new-password"
                spellCheck={false}
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor={`${baseId}-auth-method`}
                className="block text-sm font-medium text-foreground"
              >
                {t("mcpOAuthAuthMethod")}
              </label>
              <FormSelect
                id={`${baseId}-auth-method`}
                label={t("mcpOAuthAuthMethod")}
                value={authMethod}
                onValueChange={(value) =>
                  setAuthMethod(value as McpOAuthClientAuthMethod)
                }
                disabled={saving}
                options={authMethodOptions}
              />
            </div>
          </div>

          {formError ? (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          ) : null}

          <div>
            <StatefulButton
              type="submit"
              variant="primary"
              size="sm"
              state={saving ? "loading" : "idle"}
              loadingText={t("mcpOAuthSavingClient")}
              disabled={saving || !issuer.trim() || !clientId.trim()}
            >
              <Plus className="size-3.5" aria-hidden="true" />
              {t("mcpOAuthSaveClient")}
            </StatefulButton>
          </div>
        </form>
      </div>
    </AdminPanel>
  );
}
