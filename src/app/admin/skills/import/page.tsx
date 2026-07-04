'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { importSkillFromGithubAction } from '@/lib/admin/market-actions';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import type { AdminActionState } from '@/lib/admin/user-actions';

export default function ImportSkillPage() {
  const [state, formAction] = useActionState<AdminActionState, FormData>(importSkillFromGithubAction, {});
  const input = 'h-9 w-full rounded-md border border-zinc-200 px-3 text-sm font-mono dark:border-zinc-700 dark:bg-zinc-900';

  return (
    <div className="space-y-4 px-8 py-6">
      <div className="flex items-center gap-3">
        <Link href="/admin/skills" className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">← Skills</Link>
        <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">Import skill bundle</h1>
      </div>

      <form action={formAction} className="max-w-xl space-y-4">
        <div className="space-y-1">
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
            GitHub Source
          </label>
          <input
            name="githubSource"
            required
            placeholder="owner/repo/path/to/skill or https://github.com/owner/repo/tree/main/path"
            className={input}
            autoFocus
          />
          <p className="text-xs text-zinc-400">
            Imports the whole folder: <code className="font-mono">SKILL.md</code>, references,
            scripts, and other text files. Frontmatter supplies name, description, and author.
          </p>
        </div>

        <div className="rounded-lg border border-zinc-100 bg-zinc-50 p-3 text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-400">
          <p className="font-semibold text-zinc-700 dark:text-zinc-300">Examples</p>
          <ul className="mt-1 space-y-0.5 font-mono">
            <li>anthropics/skills/skills/pdf</li>
            <li>https://github.com/anthropics/skills/tree/main/skills/pdf</li>
            <li>openai/skills/skills/.curated/playwright</li>
          </ul>
        </div>

        <div className="flex items-center gap-3">
          <SubmitButton
            pendingLabel="Importing…"
            error={state.error}
            className="inline-flex h-9 items-center rounded-md bg-zinc-900 px-4 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
          >
            Import skill
          </SubmitButton>
          {state.error ? <span className="text-sm text-red-600" role="alert">{state.error}</span> : null}
        </div>
      </form>
    </div>
  );
}
