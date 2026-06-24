'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import type { AuthState } from '@/lib/auth/actions';

type Action = (prev: AuthState, formData: FormData) => Promise<AuthState>;

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
    >
      {pending ? 'Please wait…' : label}
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
  const isSignup = mode === 'signup';
  const crossLinkQuery = next ? `?next=${encodeURIComponent(next)}` : '';

  return (
    <div className="mx-auto w-full max-w-sm px-4 py-16">
      <h1 className="mb-1 text-2xl font-bold tracking-tight text-foreground">
        {isSignup ? 'Create your account' : 'Welcome back'}
      </h1>
      <p className="mb-6 text-sm text-muted-foreground">
        {isSignup
          ? 'Sign up to build your MCP Hub.'
          : 'Sign in to manage your MCP Hub.'}
      </p>

      <form action={formAction} className="space-y-4">
        {next ? <input type="hidden" name="next" value={next} /> : null}
        {isSignup && (
          <div className="space-y-1.5">
            <label htmlFor="name" className="text-sm font-medium text-foreground">
              Name
            </label>
            <input
              id="name"
              name="name"
              type="text"
              autoComplete="name"
              className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        )}

        <div className="space-y-1.5">
          <label htmlFor="email" className="text-sm font-medium text-foreground">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="password" className="text-sm font-medium text-foreground">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            minLength={8}
            autoComplete={isSignup ? 'new-password' : 'current-password'}
            className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        {state.error && (
          <p className="text-sm text-destructive" role="alert">
            {state.error}
          </p>
        )}

        <SubmitButton label={isSignup ? 'Sign up' : 'Sign in'} />
      </form>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        {isSignup ? (
          <>
            Already have an account?{' '}
            <Link
              href={`/login${crossLinkQuery}`}
              className="font-medium text-foreground underline"
            >
              Sign in
            </Link>
          </>
        ) : (
          <>
            Don&apos;t have an account?{' '}
            <Link
              href={`/signup${crossLinkQuery}`}
              className="font-medium text-foreground underline"
            >
              Sign up
            </Link>
          </>
        )}
      </p>
    </div>
  );
}
