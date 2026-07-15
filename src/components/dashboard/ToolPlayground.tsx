'use client';

import { useId, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Play, Loader2 } from 'lucide-react';
import { runMcpConsoleToolAction } from '@/lib/workspace/actions';

type Tool = {
  name: string;
  description?: string;
  inputSchema?: {
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
};

function defaultForType(type?: string): unknown {
  switch (type) {
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return '';
  }
}

function skeletonArgs(tool: Tool | undefined): string {
  const props = tool?.inputSchema?.properties ?? {};
  const obj: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(props)) {
    obj[key] = defaultForType(def.type);
  }
  return JSON.stringify(obj, null, 2);
}

export function ToolPlayground({
  deploymentId,
  workspace,
  tools,
}: {
  deploymentId: string;
  workspace: string;
  tools: Tool[];
}) {
  const t = useTranslations('console.mcp');
  const argumentsId = useId();
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
      setError(t('argumentsMustBeValidJson'));
      setLoading(false);
      return;
    }
    try {
      if (!parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) {
        setError(t('argumentsMustBeJsonObject'));
        return;
      }
      const response = await runMcpConsoleToolAction({
        workspace,
        deploymentId,
        toolName: selected,
        arguments: parsedArgs as Record<string, unknown>,
      });
      if (response.error) {
        setError(response.error === 'deploymentNotRunning'
          ? t('requestFailedDeploymentRunning')
          : t('toolCallFailed'));
      } else {
        const content = (response.result?.content as { text?: string }[] | undefined)?.[0]?.text;
        setResult(content ?? JSON.stringify(response.result, null, 2));
      }
    } catch {
      setError(t('requestFailedDeploymentRunning'));
    } finally {
      setLoading(false);
    }
  }

  if (tools.length === 0) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        {t('noToolsAvailable')}
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
            aria-pressed={selected === t.name}
            className={`min-h-11 max-w-full break-all rounded-md border px-2.5 py-1 text-left font-mono text-xs transition-colors sm:min-h-7 ${
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
        <label htmlFor={argumentsId} className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('argumentsJson')}
        </label>
        <textarea
          id={argumentsId}
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
        {t('runTool')}
      </button>

      {error ? (
        <pre role="alert" className="overflow-x-auto rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </pre>
      ) : null}
      {result !== null ? (
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('toolResult')}
          </label>
          <pre role="status" className="overflow-x-auto rounded-md border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100">
            {result}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
