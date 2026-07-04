'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Plus, Bot } from 'lucide-react';
import { createAgentAction } from '@/lib/agents/actions';
import {
  DashboardEmptyState,
  DashboardPage,
  DashboardToolbar,
} from '@/components/dashboard/DashboardUI';

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
    <DashboardPage>
      <DashboardToolbar
        actions={
          <div className="relative">
            <button
              type="button"
              onClick={() => setCreating((v) => !v)}
              className="ui-button-primary"
            >
              <Plus className="size-4" /> New agent
            </button>
            {creating ? (
              <div className="ui-panel absolute right-0 top-11 z-20 w-72 p-3">
                <form action={createAgentAction} className="space-y-2">
                  <input type="hidden" name="workspace" value={slug} />
                  <input
                    name="name"
                    autoFocus
                    required
                    maxLength={60}
                    placeholder="e.g. Research assistant"
                    className="ui-input h-9"
                  />
                  <button className="ui-button-primary w-full">
                    Create agent
                  </button>
                </form>
              </div>
            ) : null}
          </div>
        }
      >
        <p className="text-sm text-muted-foreground">
          Give a model your MCP tools and skills, then chat with it.
        </p>
      </DashboardToolbar>

      {agents.length === 0 ? (
        <DashboardEmptyState
          icon={Bot}
          description="No agents yet. Add a model provider, then create your first agent."
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((a) => (
            <li key={a.id}>
              <Link
                href={`/app/${slug}/agents/${a.id}`}
                className="ui-panel block p-4 transition-colors hover:bg-accent/40"
              >
                <p className="font-medium text-foreground">{a.name}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {a.providerName ? `${a.providerName} · ${a.model ?? 'no model'}` : 'No model selected'}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">{a.toolCount} tools attached</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </DashboardPage>
  );
}
