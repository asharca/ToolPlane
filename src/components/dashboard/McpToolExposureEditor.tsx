'use client';

import { useActionState, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Bot, CheckSquare2, Save } from 'lucide-react';
import {
  updateMcpToolExposureAction,
  type McpToolExposureActionState,
} from '@/lib/workspace/actions';

type ToolSummary = {
  name: string;
  description?: string;
};

function errorMessage(
  error: McpToolExposureActionState['error'],
  t: ReturnType<typeof useTranslations>,
): string | null {
  if (!error) return null;
  return t(error);
}

export function McpToolExposureEditor({
  workspace,
  deploymentId,
  tools,
  initialMode,
  initialAllowedTools,
  running,
}: {
  workspace: string;
  deploymentId: string;
  tools: ToolSummary[];
  initialMode: 'all' | 'allowlist';
  initialAllowedTools: string[];
  running: boolean;
}) {
  const t = useTranslations('console.mcp');
  const [state, formAction, isPending] = useActionState<McpToolExposureActionState, FormData>(
    updateMcpToolExposureAction,
    {},
  );
  const [mode, setMode] = useState<'all' | 'allowlist'>(initialMode);
  const [selected, setSelected] = useState(() => new Set(
    initialMode === 'all' ? tools.map((tool) => tool.name) : initialAllowedTools,
  ));
  const [revision, setRevision] = useState(0);

  const entries = useMemo(() => {
    const byName = new Map(tools.map((tool) => [tool.name, { ...tool, available: true }]));
    for (const name of initialAllowedTools) {
      if (!byName.has(name)) byName.set(name, { name, available: false });
    }
    return [...byName.values()];
  }, [initialAllowedTools, tools]);

  const currentNames = useMemo(() => new Set(tools.map((tool) => tool.name)), [tools]);
  const exposedCurrentCount = mode === 'all'
    ? tools.length
    : [...selected].filter((name) => currentNames.has(name)).length;
  const error = errorMessage(state.error, t);

  const selectMode = (nextMode: 'all' | 'allowlist') => {
    if (mode === 'all' && nextMode === 'allowlist') {
      setSelected(new Set(tools.map((tool) => tool.name)));
    }
    setMode(nextMode);
    setRevision((current) => current + 1);
  };
  const toggleTool = (name: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
    setRevision((current) => current + 1);
  };

  if (!running) {
    return (
      <section className="max-w-4xl border-b border-border pb-6">
        <div className="flex min-w-0 items-start gap-2.5">
          <Bot className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">{t('aiToolExposure')}</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {initialMode === 'all'
                ? t('allCurrentAndFutureTools')
                : t('selectedToolCount', { count: initialAllowedTools.length })}
            </p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <form action={formAction} className="max-w-4xl border-b border-border pb-6">
      <input type="hidden" name="workspace" value={workspace} />
      <input type="hidden" name="deploymentId" value={deploymentId} />
      <input type="hidden" name="revision" value={revision} />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <Bot className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">{t('aiToolExposure')}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('toolsExposedSummary', { count: exposedCurrentCount, total: tools.length })}
            </p>
          </div>
        </div>
        <button
          type="submit"
          disabled={isPending}
          className="ui-button-primary ui-button-sm disabled:cursor-wait disabled:opacity-70"
        >
          <Save className="size-3.5" />
          {isPending ? t('savingToolExposure') : t('saveToolExposure')}
        </button>
      </div>

      <fieldset disabled={isPending} className="mt-4">
        <legend className="sr-only">{t('aiToolExposure')}</legend>
        <div className="grid max-w-xl grid-cols-1 gap-1 rounded-md border border-border bg-muted/20 p-1 sm:grid-cols-2">
          {([
            ['all', t('allTools'), t('allCurrentAndFutureTools')],
            ['allowlist', t('selectedTools'), t('onlyCheckedTools')],
          ] as const).map(([value, label, description]) => {
            const active = mode === value;
            return (
              <label
                key={value}
                className={`cursor-pointer rounded px-3 py-2 transition-colors ${
                  active
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:bg-background/60 hover:text-foreground'
                }`}
              >
                <input
                  type="radio"
                  name="mode"
                  value={value}
                  checked={active}
                  onChange={() => selectMode(value)}
                  className="sr-only"
                />
                <span className="block text-sm font-medium">{label}</span>
                <span className="block text-xs leading-4 text-muted-foreground">{description}</span>
              </label>
            );
          })}
        </div>

        {mode === 'allowlist' ? (
          <div className="mt-4 max-w-4xl overflow-hidden rounded-md border border-border">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-3 py-2">
              <span className="text-xs text-muted-foreground">
                {t('selectedToolCount', { count: selected.size })}
              </span>
              <div className="flex items-center gap-3">
                {entries.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(new Set(
                        entries.filter((tool) => tool.available).map((tool) => tool.name),
                      ));
                      setRevision((current) => current + 1);
                    }}
                    className="ui-button-ghost ui-button-sm"
                  >
                    {t('selectAllTools')}
                  </button>
                ) : null}
                {selected.size > 0 ? (
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(new Set());
                      setRevision((current) => current + 1);
                    }}
                    className="ui-button-ghost ui-button-sm"
                  >
                    {t('clearToolSelection')}
                  </button>
                ) : null}
              </div>
            </div>

            {entries.length > 0 ? (
              <ul className="max-h-80 divide-y divide-border overflow-y-auto">
                {entries.map((tool) => (
                  <li key={tool.name}>
                    <label className="flex cursor-pointer items-start gap-3 px-3 py-3 hover:bg-muted/30">
                      <input
                        type="checkbox"
                        name="toolName"
                        value={tool.name}
                        checked={selected.has(tool.name)}
                        onChange={() => toggleTool(tool.name)}
                        className="mt-0.5 size-4 accent-foreground"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <code className="break-all font-mono text-xs text-foreground">{tool.name}</code>
                          {!tool.available ? (
                            <span className="rounded-sm border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                              {t('currentlyUnavailable')}
                            </span>
                          ) : null}
                        </span>
                        {tool.description ? (
                          <span className="mt-1 line-clamp-2 block text-xs leading-5 text-muted-foreground">
                            {tool.description}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                {running ? t('mcpReportedNoTools') : t('startMcpToSelectTools')}
              </p>
            )}
          </div>
        ) : (
          <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
            <CheckSquare2 className="size-3.5" />
            {t('futureToolsAutomaticallyExposed')}
          </p>
        )}
      </fieldset>

      <div className="mt-3 min-h-5">
        {error ? (
          <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>
        ) : state.savedAt && state.revision === revision ? (
          <p className="text-sm text-emerald-700 dark:text-emerald-400" role="status">
            {t('toolExposureSaved')}
          </p>
        ) : null}
      </div>
    </form>
  );
}
