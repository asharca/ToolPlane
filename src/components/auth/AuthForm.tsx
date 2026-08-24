'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { useTranslations } from 'next-intl';
import type { AuthState } from '@/lib/auth/actions';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@/lib/auth/password-policy';
import { useDetectedClientTimeZone } from '@/components/timezone/UserTimeZoneContext';

type Action = (prev: AuthState, formData: FormData) => Promise<AuthState>;

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  const t = useTranslations('auth');
  return (
    <button
      type="submit"
      disabled={pending}
      className="ui-button-primary h-10 w-full"
    >
      {pending ? t('pending') : label}
    </button>
  );
}

export function AuthForm({
  mode,
  action,
  next,
}: {
  mode: 'login' | 'signup';
  action: Action;
  next?: string;
}) {
  const [state, formAction] = useActionState<AuthState, FormData>(action, {});
  const t = useTranslations('auth');
  const isSignup = mode === 'signup';
  const crossLinkQuery = next ? `?next=${encodeURIComponent(next)}` : '';
  const detectedTimeZone = useDetectedClientTimeZone();

  return (
    <div className="mx-auto w-full max-w-sm px-4 py-10">
      <div className="ui-panel rounded-2xl p-6 shadow-xl shadow-black/5 sm:p-7 dark:shadow-black/20">
        <h1 className="mb-1 text-2xl font-semibold tracking-tight text-foreground">
          {isSignup ? t('signupTitle') : t('loginTitle')}
        </h1>
        <p className="mb-6 text-sm text-muted-foreground">
          {isSignup ? t('signupSubtitle') : t('loginSubtitle')}
        </p>

        <form action={formAction} className="space-y-4">
          {next ? <input type="hidden" name="next" value={next} /> : null}
          <input
            type="hidden"
            name="detectedTimeZone"
            value={detectedTimeZone ?? ''}
          />
          {isSignup && (
            <div className="space-y-1.5">
              <label htmlFor="name" className="text-sm font-medium text-foreground">
                {t('name')}
              </label>
              <input
                id="name"
                name="name"
                type="text"
                autoComplete="name"
                className="ui-input"
              />
            </div>
          )}

          <div className="space-y-1.5">
            <label htmlFor="email" className="text-sm font-medium text-foreground">
              {t('email')}
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              className="ui-input"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="password" className="text-sm font-medium text-foreground">
                {t('password')}
              </label>
              {!isSignup ? (
                <Link
                  href="/app/forgot-password"
                  className="text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                >
                  {t('forgotPasswordLink')}
                </Link>
              ) : null}
            </div>
            <input
              id="password"
              name="password"
              type="password"
              required
              minLength={isSignup ? PASSWORD_MIN_LENGTH : undefined}
              maxLength={PASSWORD_MAX_LENGTH}
              autoComplete={isSignup ? 'new-password' : 'current-password'}
              className="ui-input"
            />
            {isSignup ? (
              <p className="text-xs text-muted-foreground">
                {t('passwordHint', { min: PASSWORD_MIN_LENGTH })}
              </p>
            ) : null}
          </div>

          {state.error ? (
            <p className="text-sm text-destructive">{state.error}</p>
          ) : null}

          <SubmitButton label={isSignup ? t('createAccount') : t('signIn')} />
          {isSignup ? (
            <p className="text-center text-xs leading-5 text-muted-foreground">
              {t('agreementPrefix')}{' '}
              <Link href="/terms" className="underline underline-offset-4 hover:text-foreground">
                {t('terms')}
              </Link>{' '}
              {t('agreementAnd')}{' '}
              <Link href="/privacy" className="underline underline-offset-4 hover:text-foreground">
                {t('privacy')}
              </Link>
              {t('agreementSuffix')}
            </p>
          ) : null}
        </form>
      </div>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        {isSignup ? (
          <>
            {t('hasAccount')}{' '}
            <Link
              href={`/app/login${crossLinkQuery}`}
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              {t('signInLink')}
            </Link>
          </>
        ) : (
          <>
            {t('noAccount')}{' '}
            <Link
              href={`/app/signup${crossLinkQuery}`}
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              {t('signUpLink')}
            </Link>
          </>
        )}
      </p>
    </div>
  );
}
