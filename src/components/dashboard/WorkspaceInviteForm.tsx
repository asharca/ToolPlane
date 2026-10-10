"use client";
import { Input } from "@/components/motion/input";
import { Button } from "@/components/motion/button";

import { useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  inviteWorkspaceMemberAction,
  previewWorkspaceInviteRecipientAction,
  type WorkspaceActionState,
  type WorkspaceInvitePreviewState,
} from "@/lib/workspace/management-actions";
import { DashboardPanel } from "@/components/dashboard/DashboardUI";

export function WorkspaceInviteForm({
  workspaceSlug,
  canInvite,
}: {
  workspaceSlug: string;
  canInvite: boolean;
}) {
  const t = useTranslations("console.workspaces");
  const [state, setState] = useState<WorkspaceActionState>({});
  const [email, setEmail] = useState("");
  const currentEmail = useRef("");
  const latestRequest = useRef(0);
  const [preview, setPreview] = useState<WorkspaceInvitePreviewState | null>(
    null,
  );
  const [previewPending, setPreviewPending] = useState(false);
  const [pending, setPending] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const id = useId();
  const link = state.invitePath
    ? new URL(state.invitePath, window.location.origin).href
    : "";
  return (
    <DashboardPanel title={t("invite")} description={t("inviteHint")}>
      {canInvite ? (
        <form
          className="space-y-3"
          aria-busy={pending || previewPending}
          onSubmit={async (event) => {
            event.preventDefault();
            if (pending || previewPending) return;
            setCopyStatus("");
            setState({});
            const normalizedEmail = currentEmail.current;
            const form = new FormData();
            form.set("workspace", workspaceSlug);
            form.set("email", normalizedEmail);
            if (
              preview?.email === normalizedEmail &&
              preview.recipient !== undefined
            ) {
              form.set("recipientId", preview.recipient?.id ?? "");
              setPending(true);
              try {
                const result = await inviteWorkspaceMemberAction({}, form);
                setState(result);
                if (result.invitePath) setPreview(null);
              } catch {
                setState({ error: t("errors.failed") });
              } finally {
                setPending(false);
              }
              return;
            }
            const request = ++latestRequest.current;
            setPreviewPending(true);
            try {
              const result = await previewWorkspaceInviteRecipientAction(
                {},
                form,
              );
              if (
                request !== latestRequest.current ||
                normalizedEmail !== currentEmail.current
              )
                return;
              if (result.error) setState({ error: result.error });
              else if (
                result.email === currentEmail.current &&
                result.recipient !== undefined
              )
                setPreview(result);
            } catch {
              if (request === latestRequest.current)
                setState({ error: t("errors.failed") });
            } finally {
              if (request === latestRequest.current) setPreviewPending(false);
            }
          }}
        >
          <label htmlFor={id} className="block text-sm font-medium">
            {t("email")}
          </label>
          <Input
            id={id}
            name="email"
            type="email"
            required
            maxLength={320}
            disabled={pending}
            value={email}
            onChange={(value) => {
              setEmail(value);
              currentEmail.current = value.trim().toLowerCase();
              latestRequest.current += 1;
              setPreview(null);
              setPreviewPending(false);
              setState({});
              setCopyStatus("");
            }}
            placeholder="teammate@example.com"
            className="w-full"
          />
          {preview ? (
            <div
              className="space-y-2 rounded-lg border border-border p-3"
              role="status"
            >
              {preview.recipient ? (
                <>
                  {preview.recipient.name ? (
                    <p className="break-words font-medium">
                      {preview.recipient.name}
                    </p>
                  ) : null}
                  <p className="break-all text-sm">{preview.recipient.email}</p>
                  <p className="text-sm text-muted-foreground">
                    {t("inviteAccountWarning")}
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t("inviteUnregistered")}
                </p>
              )}
            </div>
          ) : null}
          <Button
            type="submit"
            disabled={pending || previewPending}
            variant="primary"
            size="md"
            className="h-auto min-h-10 max-w-full whitespace-normal py-2"
          >
            {pending
              ? t("working")
              : previewPending
                ? t("previewingRecipient")
                : preview
                  ? preview.recipient
                    ? t("inviteConfirmedAccount")
                    : t("createInvitation")
                  : t("previewRecipient")}
          </Button>
          {state.error ? (
            <p className="text-sm text-destructive" role="alert">
              {state.error}
            </p>
          ) : null}
          {link ? (
            <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-3">
              <p
                className="text-xs leading-5 text-muted-foreground"
                role="status"
              >
                {t("invitationCreated")}
              </p>
              <label
                htmlFor={`${id}-link`}
                className="block text-xs font-medium"
              >
                {t("invitationLink")}
              </label>
              <Input
                id={`${id}-link`}
                value={link}
                readOnly
                onFocus={(event) => event.target.select()}
                className="w-full"
              />
              <Button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(link);
                    setCopyStatus(t("copied"));
                  } catch {
                    setCopyStatus(t("copyFailed"));
                  }
                }}
                variant="secondary"
                size="sm"
              >
                {t("copyLink")}
              </Button>
              {copyStatus ? (
                <p className="text-xs" role="status">
                  {copyStatus}
                </p>
              ) : null}
            </div>
          ) : null}
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">{t("ownerOnly")}</p>
      )}
    </DashboardPanel>
  );
}
