'use client';

import { useEffect, useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Box, Braces, Clock3, KeyRound, Loader2, Play, PlugZap, Power } from 'lucide-react';
import { NativeSelect } from '@/components/ui/NativeSelect';
import {
  connectMcpInspectorAction,
  runMcpInspectorToolAction,
  type McpInspectorError,
} from '@/lib/workspace/inspector-actions';
import { startSandboxAction } from '@/lib/sandboxes/actions';

type Tool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown> & {
    properties?: Record<string, { type?: string; description?: string }>;
  };
  outputSchema?: Record<string, unknown>;
  annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean };
};

type InspectorLog = {
  request: Record<string, unknown>;
  response: unknown;
  durationMs: number;
};

export type InspectorSandbox = {
  id: string;
  name: string;
  kind: string;
  running: boolean;
  networkEnabled: boolean;
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
  sandboxes = [],
  connectedSandboxId,
  credentialsRequired = false,
}: {
  deploymentId: string;
  workspace: string;
  tools: Tool[];
  sandboxes?: InspectorSandbox[];
  connectedSandboxId?: string;
  credentialsRequired?: boolean;
}) {
  const t = useTranslations('console.mcp');
  const router = useRouter();
  const argumentsId = useId();
  const initialSandboxId = sandboxes.some((sandbox) => sandbox.id === connectedSandboxId)
    ? connectedSandboxId!
    : sandboxes.find((sandbox) => sandbox.networkEnabled)?.id ?? sandboxes[0]?.id ?? '';
  const [sandboxId, setSandboxId] = useState(initialSandboxId);
  const [activeSandboxId, setActiveSandboxId] = useState(
    connectedSandboxId === initialSandboxId ? initialSandboxId : '',
  );
  const [availableTools, setAvailableTools] = useState<Tool[]>(
    connectedSandboxId === initialSandboxId ? tools : [],
  );
  const [selected, setSelected] = useState(
    connectedSandboxId === initialSandboxId ? tools[0]?.name ?? '' : '',
  );
  const current = availableTools.find((tool) => tool.name === selected);
  const [args, setArgs] = useState(() => skeletonArgs(
    connectedSandboxId === initialSandboxId ? tools[0] : undefined,
  ));
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [startingSandboxId, setStartingSandboxId] = useState('');
  const [log, setLog] = useState<InspectorLog | null>(null);

  function onSelect(name: string) {
    setSelected(name);
    setArgs(skeletonArgs(availableTools.find((tool) => tool.name === name)));
    setResult(null);
    setError(null);
    setLog(null);
  }

  function inspectorError(error: McpInspectorError): string {
    if (error === 'sandboxRequired') return t('connectInspectorFirst');
    if (error === 'sandboxNotRunning') return t('startSandboxFirst');
    if (error === 'sandboxNetworkDisabled') return t('sandboxNetworkDisabled');
    if (error === 'unsupportedTransport') return t('unsupportedInspectorTransport');
    if (error === 'deploymentNotRunning') return t('requestFailedDeploymentRunning');
    if (error === 'credentialsRequired') return t('connectorCredentialsRequired');
    if (error === 'authenticationFailed') return t('connectorAuthenticationFailed');
    return t('sandboxConnectionFailed');
  }

  function onSandboxChange(nextSandboxId: string) {
    setSandboxId(nextSandboxId);
    setError(null);
    setResult(null);
    setLog(null);
    if (nextSandboxId !== activeSandboxId) {
      setAvailableTools([]);
      setSelected('');
      setArgs('{}');
    }
  }

  async function connectInspector() {
    if (!sandboxId) return;
    setConnecting(true);
    setError(null);
    try {
      const response = await connectMcpInspectorAction({ workspace, deploymentId, sandboxId });
      if (response.error) {
        setError(inspectorError(response.error));
        return;
      }
      const discovered = response.tools ?? [];
      setAvailableTools(discovered);
      setActiveSandboxId(sandboxId);
      setSelected(discovered[0]?.name ?? '');
      setArgs(skeletonArgs(discovered[0]));
      router.refresh();
    } catch {
      setError(t('sandboxConnectionFailed'));
    } finally {
      setConnecting(false);
    }
  }

  async function startSelectedSandbox() {
    if (!selectedSandbox) return;
    setStartingSandboxId(selectedSandbox.id);
    setError(null);
    const form = new FormData();
    form.set('workspace', workspace);
    form.set('sandboxId', selectedSandbox.id);
    try {
      await startSandboxAction(form);
      router.refresh();
    } catch {
      setStartingSandboxId('');
      setError(t('sandboxStartFailed'));
    }
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
      if (current?.annotations?.destructiveHint && !window.confirm(t('confirmDestructiveTool'))) return;
      const request = { method: 'tools/call', params: { name: selected, arguments: parsedArgs } };
      const startedAt = performance.now();
      const response = await runMcpInspectorToolAction({
        workspace,
        deploymentId,
        sandboxId,
        toolName: selected,
        arguments: parsedArgs as Record<string, unknown>,
      });
      if (response.error) {
        setLog({ request, response, durationMs: Math.round(performance.now() - startedAt) });
        setError(response.error === 'toolCallFailed'
          ? t('toolCallFailed')
          : inspectorError(response.error));
      } else {
        setLog({ request, response: response.result ?? null, durationMs: Math.round(performance.now() - startedAt) });
        const content = (response.result?.content as { text?: string }[] | undefined)?.[0]?.text;
        setResult(content ?? JSON.stringify(response.result, null, 2));
      }
    } catch {
      setError(t('requestFailedDeploymentRunning'));
    } finally {
      setLoading(false);
    }
  }

  const selectedSandbox = sandboxes.find((sandbox) => sandbox.id === sandboxId);

  useEffect(() => {
    if (!startingSandboxId) return;
    if (selectedSandbox?.running) {
      const frame = window.requestAnimationFrame(() => setStartingSandboxId(''));
      return () => window.cancelAnimationFrame(frame);
    }
    const interval = window.setInterval(() => router.refresh(), 1_250);
    const timeout = window.setTimeout(() => setStartingSandboxId(''), 30_000);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [router, selectedSandbox?.running, startingSandboxId]);

  if (credentialsRequired) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-muted/45 px-4 py-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <KeyRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t('connectorCredentialsRequired')}</p>
        </div>
        <Link
          href={`/app/${encodeURIComponent(workspace)}/mcp/${encodeURIComponent(deploymentId)}?tab=variables`}
          className="ui-button-secondary h-9"
        >
          {t('configureVariables')}
        </Link>
      </div>
    );
  }

  if (sandboxes.length === 0) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-muted/45 px-4 py-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <Box className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t('inspectorRequiresSandbox')}</p>
        </div>
        <Link href={`/app/${encodeURIComponent(workspace)}/sandboxes`} className="ui-button-secondary h-9">
          {t('createSandbox')}
        </Link>
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-5">
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-[15rem] flex-1 text-xs font-medium text-muted-foreground">
          {t('inspectorSandbox')}
          <NativeSelect
            value={sandboxId}
            onChange={(event) => onSandboxChange(event.target.value)}
            className="ui-input h-9 w-full text-foreground"
            wrapperClassName="mt-1.5"
          >
            {sandboxes.map((sandbox) => (
              <option key={sandbox.id} value={sandbox.id} disabled={!sandbox.networkEnabled}>
                {sandbox.name} · {sandbox.kind}{sandbox.running ? '' : ` · ${t('sandboxStopped')}`}
              </option>
            ))}
          </NativeSelect>
        </label>
        {selectedSandbox && !selectedSandbox.running ? (
          <button
            type="button"
            onClick={startSelectedSandbox}
            disabled={startingSandboxId === selectedSandbox.id}
            className="ui-button-primary h-9 disabled:opacity-60"
          >
            {startingSandboxId === selectedSandbox.id
              ? <Loader2 className="size-4 animate-spin" />
              : <Power className="size-4" />}
            {startingSandboxId === selectedSandbox.id ? t('startingSandbox') : t('startSandbox')}
          </button>
        ) : (
          <button
            type="button"
            onClick={connectInspector}
            disabled={!selectedSandbox?.networkEnabled || connecting}
            className="ui-button-primary h-9 disabled:opacity-60"
          >
            {connecting ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
            {connecting ? t('connectingInspector') : t('connectInspector')}
          </button>
        )}
      </div>

      {error && !availableTools.length ? (
        <pre role="alert" className="overflow-x-auto rounded-md bg-destructive/10 p-3 text-xs text-destructive-text">{error}</pre>
      ) : null}

      {activeSandboxId !== sandboxId ? (
        <p className="text-sm text-muted-foreground">{t('connectInspectorHint')}</p>
      ) : availableTools.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noToolsAvailable')}</p>
      ) : (
      <div className="grid min-w-0 gap-5 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <nav aria-label={t('inspectorTools')} className="min-w-0 space-y-1">
        <p className="mb-2 text-xs font-medium text-muted-foreground">{t('inspectorTools')}</p>
        {availableTools.map((tool) => (
          <button
            key={tool.name}
            type="button"
            onClick={() => onSelect(tool.name)}
            aria-pressed={selected === tool.name}
            className={`flex min-h-9 w-full min-w-0 items-center rounded-md px-2.5 py-1.5 text-left font-mono text-xs transition-colors ${
              selected === tool.name
                ? 'bg-muted font-semibold text-foreground'
                : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground'
            }`}
          >
            <span className="truncate">{tool.title ?? tool.name}</span>
          </button>
        ))}
      </nav>

      <div className="min-w-0 space-y-5">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="break-all font-mono text-sm font-semibold text-foreground">{current?.name}</h3>
            {current?.annotations?.readOnlyHint ? (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{t('readOnlyTool')}</span>
            ) : null}
            {current?.annotations?.destructiveHint ? (
              <span className="inline-flex items-center gap-1 rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive-text">
                <AlertTriangle className="size-3" />{t('destructiveTool')}
              </span>
            ) : null}
          </div>
          {current?.description ? <p className="mt-2 text-sm leading-6 text-muted-foreground">{current.description}</p> : null}
        </div>

        <div className="grid min-w-0 gap-4 xl:grid-cols-2">
          <div className="min-w-0">
            <p className="mb-1.5 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Braces className="size-3.5" />{t('inputSchema')}
            </p>
            <pre className="max-h-64 overflow-auto rounded-md bg-muted/55 p-3 font-mono text-xs leading-5 text-foreground">
              {JSON.stringify(current?.inputSchema ?? { type: 'object' }, null, 2)}
            </pre>
          </div>
          <div className="min-w-0">
            <p className="mb-1.5 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Braces className="size-3.5" />{t('outputSchema')}
            </p>
            <pre className="max-h-64 overflow-auto rounded-md bg-muted/55 p-3 font-mono text-xs leading-5 text-foreground">
              {JSON.stringify(current?.outputSchema ?? {}, null, 2)}
            </pre>
          </div>
        </div>

        <div>
          <label htmlFor={argumentsId} className="mb-1.5 block text-xs font-medium text-muted-foreground">{t('argumentsJson')}</label>
          <textarea
            id={argumentsId}
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            spellCheck={false}
            rows={Math.max(5, args.split('\n').length)}
            className="ui-input h-auto p-3 font-mono text-xs"
          />
        </div>

        <button type="button" onClick={run} disabled={loading || !selected} className="ui-button-primary disabled:opacity-60">
          {loading ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
          {t('runTool')}
        </button>

        {error ? <pre role="alert" className="overflow-x-auto rounded-md bg-destructive/10 p-3 text-xs text-destructive-text">{error}</pre> : null}
        {result !== null ? (
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t('toolResult')}</p>
            <pre role="status" className="max-h-96 overflow-auto rounded-md bg-muted/55 p-3 font-mono text-xs leading-5 text-foreground">{result}</pre>
          </div>
        ) : null}
        {log ? (
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground">
              <Clock3 className="size-3.5" />{t('requestLog')} · {log.durationMs} ms
            </summary>
            <div className="mt-3 grid min-w-0 gap-4 xl:grid-cols-2">
              <div className="min-w-0">
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t('request')}</p>
                <pre className="max-h-72 overflow-auto rounded-md bg-muted/55 p-3 font-mono text-xs leading-5 text-foreground">{JSON.stringify(log.request, null, 2)}</pre>
              </div>
              <div className="min-w-0">
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t('response')}</p>
                <pre className="max-h-72 overflow-auto rounded-md bg-muted/55 p-3 font-mono text-xs leading-5 text-foreground">{JSON.stringify(log.response, null, 2)}</pre>
              </div>
            </div>
          </details>
        ) : null}
      </div>
      </div>
      )}
    </div>
  );
}
