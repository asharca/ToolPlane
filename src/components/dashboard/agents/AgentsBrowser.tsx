'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Plus, Bot } from 'lucide-react';
import { createAgentAction } from '@/lib/agents/actions';

export type AgentRow = {
  id: string;
  name: string;
  providerName: string | null;
  model: string | null;
  toolCount: number;
};

export function AgentsBrowser({ slug, agents }: { slug: string; agents: AgentRow[] }) {
  const [creating, setCreating] = useState(false);

  return (
    <div className="px-8 py-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Give a model your MCP tools and skills, then chat with it.
        </p>
        <div className="relative">
          <button
            type="button"
            onClick={() => setCreating((v) => !v)}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-zinc-900 px-3 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            <Plus className="size-4" /> New agent
          </button>
          {creating ? (
            <div className="absolute right-0 top-11 z-20 w-72 rounded-lg border border-zinc-200 bg-white p-3 shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
              <form action={createAgentAction} className="space-y-2">
                <input type="hidden" name="workspace" value={slug} />
                <input
                  name="name"
                  autoFocus
                  required
                  maxLength={60}
                  placeholder="e.g. Research assistant"
                  className="h-9 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm text-zinc-900 outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                />
                <button className="inline-flex h-9 w-full items-center justify-center rounded-md bg-zinc-900 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200">
                  Create agent
                </button>
              </form>
            </div>
          ) : null}
        </div>
      </div>

      {agents.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-200 py-16 text-center dark:border-zinc-700">
          <Bot className="mx-auto size-6 text-muted-foreground" />
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
            No agents yet. Add a model provider, then create your first agent.
          </p>
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((a) => (
            <li key={a.id}>
              <Link
                href={`/app/${slug}/agents/${a.id}`}
                className="block rounded-lg border border-zinc-200 p-4 transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/50"
              >
                <p className="font-medium text-zinc-900 dark:text-zinc-100">{a.name}</p>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  {a.providerName ? `${a.providerName} · ${a.model ?? 'no model'}` : 'No model selected'}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">{a.toolCount} tools attached</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
