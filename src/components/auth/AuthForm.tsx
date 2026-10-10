"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import type { AuthState } from "@/lib/auth/actions";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "@/lib/auth/password-policy";
import { useDetectedClientTimeZone } from "@/components/timezone/UserTimeZoneContext";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { Input } from "@/components/motion/input";

type Action = (prev: AuthState, formData: FormData) => Promise<AuthState>;

export function AuthForm({
  mode,
  action,
  next,
}: {
  mode: "login" | "signup";
  action: Action;
  next?: string;
}) {
  const [state, formAction] = useActionState<AuthState, FormData>(action, {});
  const t = useTranslations("auth");
  const isSignup = mode === "signup";
  const crossLinkQuery = next ? `?next=${encodeURIComponent(next)}` : "";
  const detectedTimeZone = useDetectedClientTimeZone();

  return (
    <div className="mx-auto w-full max-w-sm px-4 py-10">
      <div className="rounded-2xl border border-border bg-card p-6 sm:p-7">
        <h1 className="mb-1 text-2xl font-semibold tracking-tight text-foreground">
          {isSignup ? t("signupTitle") : t("loginTitle")}
        </h1>
        <p className="mb-6 text-sm text-muted-foreground">
          {isSignup ? t("signupSubtitle") : t("loginSubtitle")}
        </p>

        <form action={formAction} className="space-y-4">
          {next ? <input type="hidden" name="next" value={next} /> : null}
          <input
            type="hidden"
            name="detectedTimeZone"
            value={detectedTimeZone ?? ""}
          />
          {isSignup && (
            <Input
              label={t("name")}
              id="name"
              name="name"
              type="text"
              autoComplete="name"
            />
          )}

          <Input
            label={t("email")}
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
          />

          <div className="space-y-1.5">
            {!isSignup ? (
              <div className="flex justify-end">
                <Link
                  href="/app/forgot-password"
                  className="text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                >
                  {t("forgotPasswordLink")}
                </Link>
              </div>
            ) : null}
            <Input
              label={t("password")}
              id="password"
              name="password"
              type="password"
              required
              minLength={isSignup ? PASSWORD_MIN_LENGTH : undefined}
              maxLength={PASSWORD_MAX_LENGTH}
              autoComplete={isSignup ? "new-password" : "current-password"}
            />
            {isSignup ? (
              <p className="text-xs text-muted-foreground">
                {t("passwordHint", { min: PASSWORD_MIN_LENGTH })}
              </p>
            ) : null}
          </div>

          {state.error ? (
            <p role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
          ) : null}

          <SubmitButton
            pendingLabel={t("pending")}
            flash={false}
            className="w-full"
          >
            {isSignup ? t("createAccount") : t("signIn")}
          </SubmitButton>
          {isSignup ? (
            <p className="text-center text-xs leading-5 text-muted-foreground">
              {t("agreementPrefix")}{" "}
              <Link
                href="/terms"
                className="underline underline-offset-4 hover:text-foreground"
              >
                {t("terms")}
              </Link>{" "}
              {t("agreementAnd")}{" "}
              <Link
                href="/privacy"
                className="underline underline-offset-4 hover:text-foreground"
              >
                {t("privacy")}
              </Link>
              {t("agreementSuffix")}
            </p>
          ) : null}
        </form>
      </div>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        {isSignup ? (
          <>
            {t("hasAccount")}{" "}
            <Link
              href={`/app/login${crossLinkQuery}`}
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              {t("signInLink")}
            </Link>
          </>
        ) : (
          <>
            {t("noAccount")}{" "}
            <Link
              href={`/app/signup${crossLinkQuery}`}
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              {t("signUpLink")}
            </Link>
          </>
        )}
      </p>
    </div>
  );
}
