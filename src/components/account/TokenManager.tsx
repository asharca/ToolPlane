'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { createTokenAction, revokeTokenAction } from '@/lib/auth/actions';
import type { TokenState } from '@/lib/auth/actions';

export type TokenView = {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  createdAt: string;
};

function CreateButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
    >
      {pending ? 'Creating…' : 'Create token'}
    </button>
  );
}

export function TokenManager({ tokens }: { tokens: TokenView[] }) {
  const [state, formAction] = useActionState<TokenState, FormData>(
    createTokenAction,
    {},
  );

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">API tokens</h2>
        <p className="text-sm text-muted-foreground">
          Use these tokens as a Bearer credential to connect agents to your Hub.
        </p>
      </div>

      {state.token && (
        <div className="rounded-md border border-border bg-muted/40 p-3">
          <p className="mb-1 text-xs font-medium text-foreground">
            Copy this token now — it won&apos;t be shown again:
          </p>
          <code className="block break-all font-mono text-sm text-foreground">
            {state.token}
          </code>
        </div>
      )}

      <form action={formAction} className="flex flex-wrap items-end gap-2">
        <div className="flex-1 space-y-1.5">
          <label htmlFor="token-name" className="text-sm font-medium text-foreground">
            Token name
          </label>
          <input
            id="token-name"
            name="name"
            type="text"
            placeholder="My laptop"
            className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <CreateButton />
      </form>
      {state.error && (
        <p className="text-sm text-destructive" role="alert">
          {state.error}
        </p>
      )}

      {tokens.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tokens yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {tokens.map((t) => (
            <li
              key={t.id}
              className="flex items-center justify-between gap-3 px-3 py-2.5"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">
                  {t.name}
                </p>
                <p className="truncate font-mono text-xs text-muted-foreground">
                  {t.prefix}…{' · '}
                  {t.lastUsedAt
                    ? `last used ${t.lastUsedAt}`
                    : 'never used'}
                </p>
              </div>
              <form action={revokeTokenAction}>
                <input type="hidden" name="id" value={t.id} />
                <button
                  type="submit"
                  className="inline-flex h-8 items-center rounded-md border border-border px-3 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
                >
                  Revoke
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
