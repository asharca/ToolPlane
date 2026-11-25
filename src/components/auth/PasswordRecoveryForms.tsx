"use client";

import Link from "next/link";
import { useActionState, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import type { AuthState } from "@/lib/auth/actions";
import {
  changePasswordAction,
  forgotPasswordAction,
  resetPasswordAction,
} from "@/lib/auth/actions";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "@/lib/auth/password-policy";
import {
  Alert,
  AlertContent,
  AlertDescription,
  AlertIcon,
} from "@/components/motion/alert";
import { ButtonLink } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { DialogField } from "@/components/dashboard/dialog";
import { PasswordInput } from "./PasswordInput";

function ActionMessage({ state }: { state: AuthState }) {
  if (state.error) {
    return (
      <Alert variant="destructive">
        <AlertIcon />
        <AlertContent>
          <AlertDescription>{state.error}</AlertDescription>
        </AlertContent>
      </Alert>
    );
  }
  if (state.success) {
    return (
      <Alert variant="success">
        <AlertIcon />
        <AlertContent>
          <AlertDescription>{state.success}</AlertDescription>
        </AlertContent>
      </Alert>
    );
  }
  return null;
}

export function ForgotPasswordForm({ next }: { next?: string } = {}) {
  const [state, action] = useActionState(forgotPasswordAction, {});
  const t = useTranslations("auth");
  const loginHref = next
    ? `/app/login?next=${encodeURIComponent(next)}`
    : "/app/login";

  return (
    <div className="mx-auto w-full max-w-sm px-4 py-12">
      <div className="rounded-xl border border-border bg-card p-6 sm:p-7">
        <h1 className="mb-1 text-2xl font-semibold tracking-tight text-foreground">
          {t("forgotPasswordTitle")}
        </h1>
        <p className="mb-6 text-sm text-muted-foreground">
          {t("forgotPasswordSubtitle")}
        </p>
        <form action={action} className="space-y-4">
          <Input
            label={t("email")}
            id="recovery-email"
            name="email"
            type="email"
            required
            autoComplete="email"
          />
          <ActionMessage state={state} />
          <SubmitButton
            pendingLabel={t("pending")}
            flash={false}
            className="w-full"
          >
            {t("sendResetLink")}
          </SubmitButton>
        </form>
      </div>
      <p className="mt-6 text-center text-sm text-muted-foreground">
        <Link
          href={loginHref}
          className="font-medium text-foreground underline-offset-4 hover:underline"
        >
          {t("backToSignIn")}
        </Link>
      </p>
    </div>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, action] = useActionState(resetPasswordAction, {});
  const t = useTranslations("auth");

  useEffect(() => {
    if (token) window.history.replaceState(null, "", "/app/reset-password");
  }, [token]);

  return (
    <div className="mx-auto w-full max-w-sm px-4 py-12">
      <div className="rounded-xl border border-border bg-card p-6 sm:p-7">
        <h1 className="mb-1 text-2xl font-semibold tracking-tight text-foreground">
          {t("resetPasswordTitle")}
        </h1>
        <p className="mb-6 text-sm text-muted-foreground">
          {t("resetPasswordSubtitle")}
        </p>
        {state.success ? (
          <div className="space-y-4">
            <ActionMessage state={state} />
            <ButtonLink href="/app/login" className="w-full">
              {t("continueToSignIn")}
            </ButtonLink>
          </div>
        ) : !token ? (
          <div className="space-y-4">
            <Alert variant="destructive">
              <AlertIcon />
              <AlertContent>
                <AlertDescription>
                  {state.error || t("resetLinkInvalid")}
                </AlertDescription>
              </AlertContent>
            </Alert>
            <ButtonLink href="/app/forgot-password" className="w-full">
              {t("requestNewLink")}
            </ButtonLink>
          </div>
        ) : (
          <form action={action} className="space-y-4">
            <input type="hidden" name="token" value={token} />
            <div className="space-y-1.5">
              <PasswordInput
                label={t("newPassword")}
                id="new-password"
                name="password"
                required
                minLength={PASSWORD_MIN_LENGTH}
                maxLength={PASSWORD_MAX_LENGTH}
                autoComplete="new-password"
              />
              <p className="text-xs text-muted-foreground">
                {t("passwordHint", { min: PASSWORD_MIN_LENGTH })}
              </p>
            </div>
            <PasswordInput
              label={t("confirmPassword")}
              id="password-confirmation"
              name="passwordConfirmation"
              required
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={PASSWORD_MAX_LENGTH}
              autoComplete="new-password"
            />
            <ActionMessage state={state} />
            <SubmitButton
              pendingLabel={t("pending")}
              flash={false}
              className="w-full"
            >
              {t("resetPassword")}
            </SubmitButton>
          </form>
        )}
      </div>
      {token ? (
        <p className="mt-6 text-center text-sm text-muted-foreground">
          <Link
            href="/app/forgot-password"
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            {t("requestNewLink")}
          </Link>
        </p>
      ) : null}
    </div>
  );
}

export function ChangePasswordForm({ email }: { email?: string }) {
  const [state, action] = useActionState(changePasswordAction, {});
  const t = useTranslations("auth");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  useEffect(() => {
    // Password inputs must clear after a successful server action; this state sync is intentional.
    if (state.success) {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
    }
  }, [state]);

  return (
    <form action={action} className="space-y-5">
      {email ? (
        <input
          type="email"
          name="username"
          autoComplete="username"
          value={email}
          readOnly
          hidden
        />
      ) : null}
      <div className="max-w-md space-y-5">
        <DialogField
          label={t("currentPassword")}
          htmlFor="current-password"
          dirty={currentPassword !== ""}
        >
          <PasswordInput
            id="current-password"
            name="currentPassword"
            value={currentPassword}
            onChange={setCurrentPassword}
            required
            maxLength={PASSWORD_MAX_LENGTH}
            autoComplete="current-password"
          />
        </DialogField>
        <DialogField
          label={t("newPassword")}
          htmlFor="settings-new-password"
          description={t("passwordHint", { min: PASSWORD_MIN_LENGTH })}
          dirty={newPassword !== ""}
        >
          <PasswordInput
            id="settings-new-password"
            name="newPassword"
            value={newPassword}
            onChange={setNewPassword}
            required
            minLength={PASSWORD_MIN_LENGTH}
            maxLength={PASSWORD_MAX_LENGTH}
            autoComplete="new-password"
          />
        </DialogField>
        <DialogField
          label={t("confirmPassword")}
          htmlFor="settings-password-confirmation"
          dirty={confirmation !== ""}
        >
          <PasswordInput
            id="settings-password-confirmation"
            name="passwordConfirmation"
            value={confirmation}
            onChange={setConfirmation}
            required
            minLength={PASSWORD_MIN_LENGTH}
            maxLength={PASSWORD_MAX_LENGTH}
            autoComplete="new-password"
          />
        </DialogField>
        <ActionMessage state={state} />
      </div>
      <div>
        <SubmitButton pendingLabel={t("pending")} flash={false} size="md">
          {t("changePassword")}
        </SubmitButton>
      </div>
    </form>
  );
}
