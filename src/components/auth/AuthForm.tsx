'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { useTranslations } from 'next-intl';
import type { AuthState } from '@/lib/auth/actions';

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

  return (
    <div className="mx-auto w-full max-w-sm px-4 py-16">
      <div className="ui-panel p-5 sm:p-6">
        <h1 className="mb-1 text-2xl font-bold tracking-tight text-foreground">
          {isSignup ? t('signupTitle') : t('loginTitle')}
        </h1>
        <p className="mb-6 text-sm text-muted-foreground">
          {isSignup ? t('signupSubtitle') : t('loginSubtitle')}
        </p>

        <form action={formAction} className="space-y-4">
          {next ? <input type="hidden" name="next" value={next} /> : null}
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
            <label htmlFor="password" className="text-sm font-medium text-foreground">
              {t('password')}
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete={isSignup ? 'new-password' : 'current-password'}
              className="ui-input"
            />
          </div>

          {state.error ? (
            <p className="text-sm text-destructive">{state.error}</p>
          ) : null}

          <SubmitButton label={isSignup ? t('createAccount') : t('signIn')} />
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
