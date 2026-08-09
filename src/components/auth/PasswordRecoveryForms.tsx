'use client';

import Link from 'next/link';
import { useActionState, useEffect } from 'react';
import { useFormStatus } from 'react-dom';
import { useTranslations } from 'next-intl';
import type { AuthState } from '@/lib/auth/actions';
import {
  changePasswordAction,
  forgotPasswordAction,
  resetPasswordAction,
} from '@/lib/auth/actions';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@/lib/auth/password-policy';

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  const t = useTranslations('auth');
  return (
    <button type="submit" disabled={pending} className="ui-button-primary h-10 w-full">
      {pending ? t('pending') : label}
    </button>
  );
}

function ActionMessage({ state }: { state: AuthState }) {
  if (state.error) {
    return <p role="alert" className="text-sm text-destructive">{state.error}</p>;
  }
  if (state.success) {
    return <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">{state.success}</p>;
  }
  return null;
}

export function ForgotPasswordForm() {
  const [state, action] = useActionState(forgotPasswordAction, {});
  const t = useTranslations('auth');

  return (
    <div className="mx-auto w-full max-w-sm px-4 py-16">
      <div className="ui-panel p-5 sm:p-6">
        <h1 className="mb-1 text-2xl font-bold tracking-tight text-foreground">
          {t('forgotPasswordTitle')}
        </h1>
        <p className="mb-6 text-sm text-muted-foreground">{t('forgotPasswordSubtitle')}</p>
        <form action={action} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="recovery-email" className="text-sm font-medium text-foreground">
              {t('email')}
            </label>
            <input
              id="recovery-email"
              name="email"
              type="email"
              required
              autoComplete="email"
              className="ui-input"
            />
          </div>
          <ActionMessage state={state} />
          <SubmitButton label={t('sendResetLink')} />
        </form>
      </div>
      <p className="mt-6 text-center text-sm text-muted-foreground">
        <Link href="/app/login" className="font-medium text-foreground underline-offset-4 hover:underline">
          {t('backToSignIn')}
        </Link>
      </p>
    </div>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, action] = useActionState(resetPasswordAction, {});
  const t = useTranslations('auth');

  useEffect(() => {
    if (token) window.history.replaceState(null, '', '/app/reset-password');
  }, [token]);

  return (
    <div className="mx-auto w-full max-w-sm px-4 py-16">
      <div className="ui-panel p-5 sm:p-6">
        <h1 className="mb-1 text-2xl font-bold tracking-tight text-foreground">
          {t('resetPasswordTitle')}
        </h1>
        <p className="mb-6 text-sm text-muted-foreground">{t('resetPasswordSubtitle')}</p>
        {state.success ? (
          <div className="space-y-4">
            <ActionMessage state={state} />
            <Link href="/app/login" className="ui-button-primary flex h-10 w-full items-center justify-center">
              {t('continueToSignIn')}
            </Link>
          </div>
        ) : (
          <form action={action} className="space-y-4">
            <input type="hidden" name="token" value={token} />
            <div className="space-y-1.5">
              <label htmlFor="new-password" className="text-sm font-medium text-foreground">
                {t('newPassword')}
              </label>
              <input
                id="new-password"
                name="password"
                type="password"
                required
                minLength={PASSWORD_MIN_LENGTH}
                maxLength={PASSWORD_MAX_LENGTH}
                autoComplete="new-password"
                className="ui-input"
              />
              <p className="text-xs text-muted-foreground">
                {t('passwordHint', { min: PASSWORD_MIN_LENGTH })}
              </p>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="password-confirmation" className="text-sm font-medium text-foreground">
                {t('confirmPassword')}
              </label>
              <input
                id="password-confirmation"
                name="passwordConfirmation"
                type="password"
                required
                minLength={PASSWORD_MIN_LENGTH}
                maxLength={PASSWORD_MAX_LENGTH}
                autoComplete="new-password"
                className="ui-input"
              />
            </div>
            {!token && !state.error ? (
              <p role="alert" className="text-sm text-destructive">{t('resetLinkInvalid')}</p>
            ) : null}
            <ActionMessage state={state} />
            <SubmitButton label={t('resetPassword')} />
          </form>
        )}
      </div>
      <p className="mt-6 text-center text-sm text-muted-foreground">
        <Link href="/app/forgot-password" className="font-medium text-foreground underline-offset-4 hover:underline">
          {t('requestNewLink')}
        </Link>
      </p>
    </div>
  );
}

export function ChangePasswordForm() {
  const [state, action] = useActionState(changePasswordAction, {});
  const t = useTranslations('auth');

  return (
    <form action={action} className="max-w-md space-y-4">
      <div className="space-y-1.5">
        <label htmlFor="current-password" className="text-sm font-medium text-foreground">
          {t('currentPassword')}
        </label>
        <input
          id="current-password"
          name="currentPassword"
          type="password"
          required
          maxLength={PASSWORD_MAX_LENGTH}
          autoComplete="current-password"
          className="ui-input h-9"
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="settings-new-password" className="text-sm font-medium text-foreground">
          {t('newPassword')}
        </label>
        <input
          id="settings-new-password"
          name="newPassword"
          type="password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
          autoComplete="new-password"
          className="ui-input h-9"
        />
        <p className="text-xs text-muted-foreground">
          {t('passwordHint', { min: PASSWORD_MIN_LENGTH })}
        </p>
      </div>
      <div className="space-y-1.5">
        <label htmlFor="settings-password-confirmation" className="text-sm font-medium text-foreground">
          {t('confirmPassword')}
        </label>
        <input
          id="settings-password-confirmation"
          name="passwordConfirmation"
          type="password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
          autoComplete="new-password"
          className="ui-input h-9"
        />
      </div>
      <ActionMessage state={state} />
      <SubmitButton label={t('changePassword')} />
    </form>
  );
}
