"use client";

import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { CheckCircle2, Link2, Loader2, Mail, UserRound } from "lucide-react";
import { Button } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import { CenterMorphModalClose } from "@/components/motion/center-morph-modal";
import { CopyButton } from "@/components/dashboard/CopyButton";
import {
  DialogBody,
  DialogCancel,
  DialogFooter,
  DialogHeader,
} from "@/components/dashboard/dialog";
import {
  inviteWorkspaceMemberAction,
  previewWorkspaceInviteRecipientAction,
  type WorkspaceInvitePreviewState,
} from "@/lib/workspace/management-actions";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOOKUP_DELAY_MS = 350;

type Recipient = NonNullable<WorkspaceInvitePreviewState["recipient"]>;
type Lookup = { email: string; recipient: Recipient | null };

/**
 * Invitation flow inside the members page dialog. The recipient account is
 * looked up as the email is typed; the server re-checks it on submit.
 */
export function InviteMemberDialogContent({
  slug,
  initialEmail,
  onBusyChange,
}: {
  slug: string;
  initialEmail: string;
  onBusyChange: (busy: boolean) => void;
}) {
  const t = useTranslations("console.members");
  const workspaces = useTranslations("console.workspaces");
  const id = useId();
  const [email, setEmail] = useState(initialEmail);
  const normalized = email.trim().toLowerCase();
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [lookupPending, setLookupPending] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{
    email: string;
    link: string;
  } | null>(null);
  const latestLookup = useRef(0);
  const current = lookup?.email === normalized ? lookup : null;

  useEffect(() => onBusyChange(pending), [onBusyChange, pending]);

  const runLookup = async (value: string) => {
    const request = ++latestLookup.current;
    setLookupPending(true);
    const form = new FormData();
    form.set("workspace", slug);
    form.set("email", value);
    try {
      const result = await previewWorkspaceInviteRecipientAction({}, form);
      if (request !== latestLookup.current) return;
      if (result.error) setError(result.error);
      else if (result.email === value && result.recipient !== undefined)
        setLookup({ email: value, recipient: result.recipient });
    } catch {
      if (request === latestLookup.current)
        setError(workspaces("errors.failed"));
    } finally {
      if (request === latestLookup.current) setLookupPending(false);
    }
  };
  const lookupTyped = useEffectEvent((value: string) => void runLookup(value));

  useEffect(() => {
    if (created || !EMAIL.test(normalized)) return;
    const timer = setTimeout(() => lookupTyped(normalized), LOOKUP_DELAY_MS);
    return () => clearTimeout(timer);
  }, [normalized, created]);

  const submit = async () => {
    if (pending || lookupPending || !EMAIL.test(normalized)) return;
    setError("");
    if (!current) {
      await runLookup(normalized);
      return;
    }
    const form = new FormData();
    form.set("workspace", slug);
    form.set("email", normalized);
    form.set("recipientId", current.recipient?.id ?? "");
    setPending(true);
    try {
      const result = await inviteWorkspaceMemberAction({}, form);
      if (result.error) setError(result.error);
      else if (result.invitePath)
        setCreated({
          email: normalized,
          link: new URL(result.invitePath, window.location.origin).href,
        });
    } catch {
      setError(workspaces("errors.failed"));
    } finally {
      setPending(false);
    }
  };

  if (created) {
    return (
      <div className="flex min-h-0 flex-col">
        <DialogHeader
          title={t("invitationReady")}
          icon={
            <CheckCircle2
              className="size-5 text-emerald-600 dark:text-emerald-400"
              aria-hidden
            />
          }
        />
        <DialogBody className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {t("invitationLinkHint", { email: created.email })}
          </p>
          <div className="flex items-center gap-2">
            <Input
              aria-label={t("invitationLink")}
              value={created.link}
              readOnly
              onFocus={(event) => event.target.select()}
              leftIcon={<Link2 />}
              className="min-w-0 flex-1"
            />
            <CopyButton text={created.link} label={t("copyLink")} />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            size="md"
            onClick={() => {
              setCreated(null);
              setEmail("");
              setLookup(null);
            }}
          >
            {t("inviteAnother")}
          </Button>
          <CenterMorphModalClose>
            <Button type="button" variant="primary" size="md">
              {t("done")}
            </Button>
          </CenterMorphModalClose>
        </DialogFooter>
      </div>
    );
  }

  return (
    <form
      className="flex min-h-0 flex-col"
      aria-busy={pending || lookupPending}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <DialogHeader title={t("invite")} description={t("inviteDescription")} />
      <DialogBody className="space-y-3">
        <label htmlFor={id} className="block text-sm font-medium">
          {t("email")}
        </label>
        <Input
          id={id}
          name="email"
          type="email"
          required
          autoFocus
          autoComplete="off"
          maxLength={320}
          disabled={pending}
          value={email}
          onChange={(value) => {
            setEmail(value);
            setError("");
            latestLookup.current += 1;
            setLookupPending(false);
          }}
          leftIcon={<Mail />}
          placeholder="teammate@example.com"
          className="w-full"
        />
        <div className="min-h-14" aria-live="polite">
          {lookupPending && !current ? (
            <p className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              {t("lookingUp")}
            </p>
          ) : current ? (
            <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 p-3">
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-background text-muted-foreground">
                <UserRound className="size-4" aria-hidden />
              </span>
              <div className="min-w-0 space-y-0.5 text-sm">
                {current.recipient ? (
                  <>
                    <p className="truncate font-medium">
                      {current.recipient.name ?? current.recipient.email}
                    </p>
                    <p className="truncate text-muted-foreground">
                      {t("registeredAccount")}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t("unverifiedEmail")}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="truncate font-medium">{current.email}</p>
                    <p className="text-muted-foreground">
                      {t("unregisteredAccount")}
                    </p>
                  </>
                )}
              </div>
            </div>
          ) : null}
          {error ? (
            <p className="py-2 text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </DialogBody>
      <DialogFooter cancel={<DialogCancel disabled={pending} />}>
        <Button
          type="submit"
          variant="primary"
          size="md"
          disabled={pending || lookupPending || !EMAIL.test(normalized)}
        >
          {pending
            ? t("inviting")
            : current?.recipient === null
              ? t("createLink")
              : t("sendInvitation")}
        </Button>
      </DialogFooter>
    </form>
  );
}
