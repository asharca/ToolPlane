'use client';

import Link from 'next/link';
import { useActionState, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { AuthState } from '@/lib/auth/actions';
import {
  changePasswordAction,
  forgotPasswordAction,
  resetPasswordAction,
} from '@/lib/auth/actions';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@/lib/auth/password-policy';
import { ButtonLink } from '@/components/motion/button';
import { Input } from '@/components/motion/input';
import { AnimatedBadge } from '@/components/motion/animated-badge';
import { SubmitButton } from '@/components/dashboard/SubmitButton';


function ActionMessage({ state }: { state: AuthState }) {
  if (state.error) {
    return <p role="alert" className="text-sm text-destructive">{state.error}</p>;
  }
  if (state.success) {
    return (
      <p role="status" className="flex items-start gap-2 text-sm text-foreground">
        <AnimatedBadge status="success" size="sm" aria-hidden="true" />
        <span className="min-w-0">{state.success}</span>
      </p>
    );
  }
  return null;
}

export function ForgotPasswordForm() {
  const [state, action] = useActionState(forgotPasswordAction, {});
  const t = useTranslations('auth');

  return (
    <div className="mx-auto w-full max-w-sm px-4 py-16">
      <div className="rounded-2xl border border-border bg-card p-5 sm:p-6">
        <h1 className="mb-1 text-2xl font-bold tracking-tight text-foreground">
          {t('forgotPasswordTitle')}
        </h1>
        <p className="mb-6 text-sm text-muted-foreground">{t('forgotPasswordSubtitle')}</p>
        <form action={action} className="space-y-4">
          <Input
            label={t('email')}
            id="recovery-email"
            name="email"
            type="email"
            required
            autoComplete="email"
          />
          <ActionMessage state={state} />
          <SubmitButton pendingLabel={t('pending')} flash={false} className="w-full">{t('sendResetLink')}</SubmitButton>
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
      <div className="rounded-2xl border border-border bg-card p-5 sm:p-6">
        <h1 className="mb-1 text-2xl font-bold tracking-tight text-foreground">
          {t('resetPasswordTitle')}
        </h1>
        <p className="mb-6 text-sm text-muted-foreground">{t('resetPasswordSubtitle')}</p>
        {state.success ? (
          <div className="space-y-4">
            <ActionMessage state={state} />
            <ButtonLink href="/app/login" className="w-full">
              {t('continueToSignIn')}
            </ButtonLink>
          </div>
        ) : (
          <form action={action} className="space-y-4">
            <input type="hidden" name="token" value={token} />
            <div className="space-y-1.5">
              <Input
                label={t('newPassword')}
                id="new-password"
                name="password"
                type="password"
                required
                minLength={PASSWORD_MIN_LENGTH}
                maxLength={PASSWORD_MAX_LENGTH}
                autoComplete="new-password"
              />
              <p className="text-xs text-muted-foreground">
                {t('passwordHint', { min: PASSWORD_MIN_LENGTH })}
              </p>
            </div>
            <Input
              label={t('confirmPassword')}
              id="password-confirmation"
              name="passwordConfirmation"
              type="password"
              required
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={PASSWORD_MAX_LENGTH}
              autoComplete="new-password"
            />
            {!token && !state.error ? (
              <p role="alert" className="text-sm text-destructive">{t('resetLinkInvalid')}</p>
            ) : null}
            <ActionMessage state={state} />
            <SubmitButton pendingLabel={t('pending')} flash={false} className="w-full">{t('resetPassword')}</SubmitButton>
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
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  useEffect(() => {
    // Password inputs must clear after a successful server action; this state sync is intentional.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (state.success) { setCurrentPassword(''); setNewPassword(''); setConfirmation(''); }
  }, [state]);

  return (
    <form action={action} className="max-w-md space-y-4">
      <Input
        label={t('currentPassword')}
        id="current-password"
        name="currentPassword"
        type="password"
        value={currentPassword}
        onChange={setCurrentPassword}
        required
        maxLength={PASSWORD_MAX_LENGTH}
        autoComplete="current-password"
      />
      <div className="space-y-1.5">
        <Input
          label={t('newPassword')}
          id="settings-new-password"
          name="newPassword"
          type="password"
          value={newPassword}
          onChange={setNewPassword}
          required
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
          autoComplete="new-password"
        />
        <p className="text-xs text-muted-foreground">
          {t('passwordHint', { min: PASSWORD_MIN_LENGTH })}
        </p>
      </div>
      <Input
        label={t('confirmPassword')}
        id="settings-password-confirmation"
        name="passwordConfirmation"
        type="password"
        value={confirmation}
        onChange={setConfirmation}
        required
        minLength={PASSWORD_MIN_LENGTH}
        maxLength={PASSWORD_MAX_LENGTH}
        autoComplete="new-password"
      />
      <ActionMessage state={state} />
      <SubmitButton pendingLabel={t('pending')} flash={false} className="w-full">{t('changePassword')}</SubmitButton>
    </form>
  );
}
