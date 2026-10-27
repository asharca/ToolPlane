"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import {
  approveUnsafeRemoteMcpHttpAction,
  type McpJsonConfigActionState,
} from "@/lib/workspace/actions";
import { SubmitButton } from "./SubmitButton";
import { McpSharedChangeConfirmation } from "./McpSharedChangeConfirmation";
import { RemoteMcpTransportNotice } from "./RemoteMcpTransportNotice";

export function McpHttpConsent({
  required = false,
  onChange,
}: {
  required?: boolean;
  onChange?: (checked: boolean) => void;
}) {
  const t = useTranslations("console.mcp");
  return (
    <label className="flex items-start gap-3 rounded-lg border border-border p-3 text-sm">
      <input
        type="checkbox"
        name="allowUnsafeHttp"
        value="true"
        required={required}
        onChange={(event) => onChange?.(event.target.checked)}
        className="mt-1 size-4 shrink-0"
      />
      <span>
        {t("unsafeHttpConsent")}
        <span className="mt-1 block text-xs text-muted-foreground">
          {t("unsafeHttpConsentDescription")}
        </span>
      </span>
    </label>
  );
}

export function McpHttpApprovalForm({
  workspace,
  deploymentId,
  url,
}: {
  workspace: string;
  deploymentId: string;
  url: string;
}) {
  const t = useTranslations("console.mcp");
  const [state, action] = useActionState<McpJsonConfigActionState, FormData>(
    async (_previous, form) => approveUnsafeRemoteMcpHttpAction(form),
    {},
  );
  return (
    <form
      action={action}
      className="space-y-4 rounded-xl border border-border p-5"
    >
      <input type="hidden" name="workspace" value={workspace} />
      <input type="hidden" name="deploymentId" value={deploymentId} />
      <RemoteMcpTransportNotice url={url} />
      <McpHttpConsent required />
      <McpSharedChangeConfirmation
        workspace={workspace}
        deploymentId={deploymentId}
        impactedObjects={state.impactedObjects}
      />
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {t(state.error)}
        </p>
      ) : null}
      {state.savedAt ? <p role="status">{t("connectionSaved")}</p> : null}
      <SubmitButton
        pendingLabel={t("savingVariables")}
        error={state.error ? t(state.error) : null}
      >
        {t("unsafeHttpConsent")}
      </SubmitButton>
    </form>
  );
}
