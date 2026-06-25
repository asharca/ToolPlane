'use client';

import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { deleteAgentAction } from '@/lib/agents/actions';

export function DeleteAgentButton({ slug, agentId }: { slug: string; agentId: string }) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="inline-flex h-9 items-center gap-1.5 rounded-md border border-red-200 px-3 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 dark:border-red-500/30 dark:text-red-400 dark:hover:bg-red-950/30"
      >
        <Trash2 className="size-4" /> Delete agent
      </button>
    );
  }

  return (
    <form action={deleteAgentAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="workspace" value={slug} />
      <input type="hidden" name="agentId" value={agentId} />
      <span className="text-sm text-zinc-600 dark:text-zinc-300">
        Delete this agent and all its conversations?
      </span>
      <button className="inline-flex h-9 items-center rounded-md bg-red-600 px-3 text-sm font-medium text-white transition-colors hover:bg-red-700">
        Confirm delete
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="inline-flex h-9 items-center rounded-md border border-zinc-200 px-3 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
      >
        Cancel
      </button>
    </form>
  );
}
