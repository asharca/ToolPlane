'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { KeyRound, Copy, Check, Trash2 } from 'lucide-react';
import { createTokenAction, revokeTokenAction } from '@/lib/auth/actions';
import type { TokenState } from '@/lib/auth/actions';
import {
  DashboardEmptyState,
  DashboardPanel,
} from './DashboardUI';

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
      className="ui-button-primary disabled:opacity-60"
    >
      {pending ? 'Creating…' : 'Create token'}
    </button>
  );
}

function NewTokenReveal({ token }: { token: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 dark:border-emerald-500/30 dark:bg-emerald-500/10">
      <p className="mb-2 text-xs font-medium text-emerald-800 dark:text-emerald-300">
        Copy this token now — you won’t be able to see it again.
      </p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-card px-2 py-1.5 font-mono text-sm text-foreground">
          {token}
        </code>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(token).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="ui-button-secondary ui-button-sm shrink-0"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

export function TokenManager({
  tokens,
  workspaceSlug,
}: {
  tokens: TokenView[];
  workspaceSlug: string;
}) {
  const [state, formAction] = useActionState<TokenState, FormData>(
    createTokenAction,
    {},
  );

  return (
    <DashboardPanel
      title="API Tokens"
      description="Personal Bearer tokens for the MCP gateway and JSON API. Scoped to your account, not this workspace."
    >
      <div className="space-y-4">
        {state.token ? <NewTokenReveal token={state.token} /> : null}

        <form action={formAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="workspace" value={workspaceSlug} />
          <div className="flex-1 space-y-1.5">
            <label
              htmlFor="token-name"
              className="text-sm font-medium text-foreground"
            >
              Token name
            </label>
            <input
              id="token-name"
              name="name"
              type="text"
              placeholder="e.g. My laptop"
              className="ui-input h-9"
            />
          </div>
          <CreateButton />
        </form>
        {state.error ? (
          <p className="text-sm text-red-600 dark:text-red-400" role="alert">
            {state.error}
          </p>
        ) : null}

        {tokens.length === 0 ? (
          <DashboardEmptyState
            icon={KeyRound}
            title="No tokens yet"
            description="Create one above to connect an agent or CLI."
            className="min-h-48"
          />
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
            {tokens.map((t) => (
              <li
                key={t.id}
                className="flex items-center justify-between gap-3 px-3.5 py-3"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <KeyRound className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {t.name || 'Untitled token'}
                    </p>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {t.prefix}… · {t.lastUsedAt ? `last used ${t.lastUsedAt}` : 'never used'} · created {t.createdAt}
                    </p>
                  </div>
                </div>
                <form action={revokeTokenAction}>
                  <input type="hidden" name="id" value={t.id} />
                  <input type="hidden" name="workspace" value={workspaceSlug} />
                  <button
                    type="submit"
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-200 px-2.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 dark:border-zinc-800 dark:text-red-400 dark:hover:bg-red-950/30"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Revoke
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </div>
    </DashboardPanel>
  );
}
