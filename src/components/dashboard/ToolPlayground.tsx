'use client';

import { useMemo, useState } from 'react';
import { Play, Loader2 } from 'lucide-react';

type Tool = {
  name: string;
  description?: string;
  inputSchema?: {
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
};

function skeletonArgs(tool: Tool | undefined): string {
  const props = tool?.inputSchema?.properties ?? {};
  const obj: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(props)) {
    obj[key] = def.type === 'number' ? 0 : '';
  }
  return JSON.stringify(obj, null, 2);
}

export function ToolPlayground({
  deploymentId,
  tools,
}: {
  deploymentId: string;
  tools: Tool[];
}) {
  const [selected, setSelected] = useState(tools[0]?.name ?? '');
  const current = useMemo(
    () => tools.find((t) => t.name === selected),
    [tools, selected],
  );
  const [args, setArgs] = useState(() => skeletonArgs(tools[0]));
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function onSelect(name: string) {
    setSelected(name);
    setArgs(skeletonArgs(tools.find((t) => t.name === name)));
    setResult(null);
    setError(null);
  }

  async function run() {
    setLoading(true);
    setResult(null);
    setError(null);
    let parsedArgs: unknown = {};
    try {
      parsedArgs = args.trim() ? JSON.parse(args) : {};
    } catch {
      setError('Arguments must be valid JSON.');
      setLoading(false);
      return;
    }
    try {
      const res = await fetch(`/api/v1/mcp/${deploymentId}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'tools/call',
          params: { name: selected, arguments: parsedArgs },
        }),
      });
      const json = await res.json();
      if (json.error) {
        setError(json.error.message ?? 'Tool call failed.');
      } else {
        const content = json.result?.content?.[0]?.text;
        setResult(content ?? JSON.stringify(json.result, null, 2));
      }
    } catch {
      setError('Request failed — is the deployment running?');
    } finally {
      setLoading(false);
    }
  }

  if (tools.length === 0) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        No tools available — start the deployment to inspect its tools.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {tools.map((t) => (
          <button
            key={t.name}
            type="button"
            onClick={() => onSelect(t.name)}
            className={`rounded-md border px-2.5 py-1 font-mono text-xs transition-colors ${
              selected === t.name
                ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
                : 'border-zinc-200 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800'
            }`}
          >
            {t.name}
          </button>
        ))}
      </div>

      {current?.description ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {current.description}
        </p>
      ) : null}

      <div>
        <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-400">
          Arguments (JSON)
        </label>
        <textarea
          value={args}
          onChange={(e) => setArgs(e.target.value)}
          spellCheck={false}
          rows={Math.max(3, args.split('\n').length)}
          className="w-full rounded-md border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs text-zinc-900 outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
        />
      </div>

      <button
        type="button"
        onClick={run}
        disabled={loading}
        className="inline-flex h-9 items-center gap-2 rounded-md bg-zinc-900 px-4 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        {loading ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Play className="size-4" />
        )}
        Run tool
      </button>

      {error ? (
        <pre className="overflow-x-auto rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </pre>
      ) : null}
      {result !== null ? (
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-400">
            Result
          </label>
          <pre className="overflow-x-auto rounded-md border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100">
            {result}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
