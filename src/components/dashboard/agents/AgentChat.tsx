'use client';

import { useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import Link from 'next/link';
import { Send, Plus } from 'lucide-react';
import { createConversationAction } from '@/lib/agents/actions';

type Conversation = { id: string; title: string | null; createdAt: string };

export function AgentChat({
  slug,
  agentId,
  conversationId,
  initialMessages,
  conversations,
  ready,
}: {
  slug: string;
  agentId: string;
  conversationId: string | null;
  initialMessages: UIMessage[];
  conversations: Conversation[];
  ready: boolean;
}) {
  const [text, setText] = useState('');
  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({
      api: `/api/v1/agents/${agentId}/chat`,
      body: { conversationId },
    }),
    messages: initialMessages,
  });

  const busy = status === 'streaming' || status === 'submitted';

  return (
    <div className="grid gap-4 px-8 py-6 lg:grid-cols-[14rem_1fr]">
      <aside className="space-y-2">
        <form action={createConversationAction}>
          <input type="hidden" name="workspace" value={slug} />
          <input type="hidden" name="agentId" value={agentId} />
          <button className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-md border border-zinc-200 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800">
            <Plus className="size-4" /> New chat
          </button>
        </form>
        <ul className="space-y-1">
          {conversations.map((c) => (
            <li key={c.id}>
              <Link
                href={`/app/${slug}/agents/${agentId}?tab=chat&c=${c.id}`}
                className={`block truncate rounded-md px-3 py-2 text-sm ${
                  c.id === conversationId
                    ? 'bg-zinc-200/70 font-medium text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
                    : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800/70'
                }`}
              >
                {c.title ?? `Chat ${c.createdAt}`}
              </Link>
            </li>
          ))}
        </ul>
      </aside>

      <div className="flex min-h-[28rem] flex-col rounded-lg border border-zinc-200 dark:border-zinc-800">
        {!ready ? (
          <div className="m-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
            Pick a provider and model on the Settings tab before chatting.
          </div>
        ) : null}

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {messages.map((m) => (
            <div key={m.id} className={m.role === 'user' ? 'text-right' : 'text-left'}>
              <div
                className={`inline-block max-w-[80%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                  m.role === 'user'
                    ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                    : 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
                }`}
              >
                {m.parts.map((part, i) => {
                  if (part.type === 'text') return <span key={i}>{part.text}</span>;
                  if (part.type.startsWith('tool-') || part.type === 'dynamic-tool') {
                    const p = part as { type: string; state?: string; input?: unknown; output?: unknown };
                    return (
                      <div key={i} className="my-1 rounded border border-zinc-300 bg-white/60 p-2 font-mono text-[11px] text-zinc-600 dark:border-zinc-600 dark:bg-zinc-900/60 dark:text-zinc-300">
                        🔧 {p.type.replace(/^tool-/, '')} {p.state ? `(${p.state})` : ''}
                        {p.output !== undefined ? (
                          <pre className="mt-1 overflow-x-auto">{JSON.stringify(p.output, null, 2)}</pre>
                        ) : null}
                      </div>
                    );
                  }
                  return null;
                })}
              </div>
            </div>
          ))}
          {busy ? <p className="text-sm text-zinc-400">…</p> : null}
        </div>

        {error ? (
          <p
            role="alert"
            className="mx-4 mb-2 rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
          >
            {error.message}
          </p>
        ) : null}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim() || !ready || !conversationId) return;
            sendMessage({ text });
            setText('');
          }}
          className="flex items-center gap-2 border-t border-zinc-200 p-3 dark:border-zinc-800"
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={conversationId ? 'Message your agent…' : 'Start a new chat first'}
            disabled={!ready || !conversationId || busy}
            className="h-10 flex-1 rounded-md border border-zinc-200 bg-white px-3 text-sm text-zinc-900 outline-none focus:ring-2 focus:ring-zinc-400 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          />
          <button
            type="submit"
            disabled={!ready || !conversationId || busy}
            className="inline-flex h-10 items-center gap-1.5 rounded-md bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            <Send className="size-4" /> Send
          </button>
        </form>
      </div>
    </div>
  );
}
