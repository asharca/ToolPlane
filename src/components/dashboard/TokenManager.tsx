'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { KeyRound, Copy, Check, Trash2 } from 'lucide-react';
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
      className="inline-flex h-9 items-center rounded-md bg-zinc-900 px-4 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
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
        <code className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1.5 font-mono text-sm text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100">
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
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
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
    <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
      <div className="border-b border-zinc-100 px-5 py-4 dark:border-zinc-800">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          API Tokens
        </h2>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          Personal Bearer tokens for the MCP gateway and JSON API. Scoped to your
          account, not this workspace.
        </p>
      </div>

      <div className="space-y-4 px-5 py-5">
        {state.token ? <NewTokenReveal token={state.token} /> : null}

        <form action={formAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="workspace" value={workspaceSlug} />
          <div className="flex-1 space-y-1.5">
            <label
              htmlFor="token-name"
              className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
            >
              Token name
            </label>
            <input
              id="token-name"
              name="name"
              type="text"
              placeholder="e.g. My laptop"
              className="h-9 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm text-zinc-900 outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
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
          <div className="flex flex-col items-center gap-1 rounded-md border border-dashed border-zinc-200 py-8 text-center dark:border-zinc-800">
            <KeyRound className="h-5 w-5 text-muted-foreground" />
            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              No tokens yet
            </p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Create one above to connect an agent or CLI.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-zinc-100 overflow-hidden rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {tokens.map((t) => (
              <li
                key={t.id}
                className="flex items-center justify-between gap-3 px-3.5 py-3"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                    <KeyRound className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                      {t.name || 'Untitled token'}
                    </p>
                    <p className="truncate font-mono text-xs text-zinc-500 dark:text-zinc-400">
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
    </section>
  );
}
