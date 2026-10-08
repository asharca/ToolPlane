'use client';
import { AnimatedBadge } from '@/components/motion/animated-badge';
import { BouncyAccordion } from '@/components/motion/bouncy-accordion';

import { FormSelect } from '@/components/ui/FormSelect';

import { ButtonLink, Button } from '@/components/motion/button';


import { useEffect, useId, useState } from 'react';
import { useTranslations } from 'next-intl';

import { useRouter } from 'next/navigation';
import { AlertTriangle, Box, Braces, Clock3, KeyRound, Loader2, Play, PlugZap, Power } from 'lucide-react';
import { connectMcpInspectorAction, runMcpInspectorToolAction } from '@/lib/workspace/inspector-actions';
import { runMcpConsoleToolAction } from '@/lib/workspace/actions';
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
  defaultRuntime = false,
}: {
  deploymentId: string;
  workspace: string;
  tools: Tool[];
  sandboxes?: InspectorSandbox[];
  connectedSandboxId?: string;
  credentialsRequired?: boolean;
  defaultRuntime?: boolean;
}) {
  const t = useTranslations('console.mcp');
  const router = useRouter();
  const argumentsId = useId();
  const initialSandboxId = sandboxes.some((sandbox) => sandbox.id === connectedSandboxId)
    ? connectedSandboxId!
    : sandboxes.find((sandbox) => sandbox.networkEnabled)?.id ?? sandboxes[0]?.id ?? '';
  const initiallyConnected = defaultRuntime || connectedSandboxId === initialSandboxId;
  const [sandboxId, setSandboxId] = useState(initialSandboxId);
  const [activeSandboxId, setActiveSandboxId] = useState(
    initiallyConnected ? initialSandboxId : '',
  );
  const [availableTools, setAvailableTools] = useState<Tool[]>(
    initiallyConnected ? tools : [],
  );
  const [selected, setSelected] = useState(
    initiallyConnected ? tools[0]?.name ?? '' : '',
  );
  const current = availableTools.find((tool) => tool.name === selected);
  const [args, setArgs] = useState(() => skeletonArgs(
    initiallyConnected ? tools[0] : undefined,
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

  function inspectorError(error: string): string {
    if (error === 'notAuthorized' || error === 'deploymentNotFound') return t('toolAccessDenied');
    if (error === 'invalidToolCall') return t('invalidToolCall');
    if (error === 'toolDiscoveryFailed') return t('toolDiscoveryFailed');
    if (error === 'sandboxRequired') return t('connectInspectorFirst');
    if (error === 'sandboxNotRunning') return t('startSandboxFirst');
    if (error === 'sandboxNetworkDisabled') return t('sandboxNetworkDisabled');
    if (error === 'unsupportedTransport') return t('unsupportedInspectorTransport');
    if (error === 'deploymentNotRunning') return t('requestFailedDeploymentRunning');
    if (error === 'credentialsRequired') return t('connectorCredentialsRequired');
    if (error === 'authenticationFailed') return t('connectorAuthenticationFailed');
    return t(defaultRuntime ? 'toolCallFailed' : 'sandboxConnectionFailed');
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
      const response = defaultRuntime
        ? await runMcpConsoleToolAction({
            workspace,
            deploymentId,
            toolName: selected,
            arguments: parsedArgs as Record<string, unknown>,
          })
        : await runMcpInspectorToolAction({
            workspace,
            deploymentId,
            sandboxId,
            toolName: selected,
            arguments: parsedArgs as Record<string, unknown>,
          });
      if (response.error) {
        setLog({ request, response: null, durationMs: Math.round(performance.now() - startedAt) });
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
        <ButtonLink href={`/app/${encodeURIComponent(workspace)}/mcp/${encodeURIComponent(deploymentId)}?tab=variables`} variant="secondary" size="sm">
          {t('configureVariables')}
        </ButtonLink>
      </div>
    );
  }

  if (!defaultRuntime && sandboxes.length === 0) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-muted/45 px-4 py-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <Box className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t('inspectorRequiresSandbox')}</p>
        </div>
        <ButtonLink href={`/app/${encodeURIComponent(workspace)}/sandboxes`} variant="secondary" size="sm">
          {t('createSandbox')}
        </ButtonLink>
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-5">
      {!defaultRuntime ? <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-[15rem] flex-1 text-xs font-medium text-muted-foreground">
          {t('inspectorSandbox')}
          <FormSelect value={sandboxId} onValueChange={(value) => onSandboxChange(value)} label={t('inspectorSandbox')} options={sandboxes.map((sandbox) => ({ value: sandbox.id, label: `${sandbox.name} · ${sandbox.kind}${sandbox.running ? '' : ` · ${t('sandboxStopped')}`}`, disabled: !sandbox.networkEnabled }))} />
        </label>
        {selectedSandbox && !selectedSandbox.running ? (
          <Button type="button" onClick={startSelectedSandbox} disabled={startingSandboxId === selectedSandbox.id} variant="primary" size="sm">{startingSandboxId === selectedSandbox.id
            ? <Loader2 className="size-4 animate-spin" />
            : <Power className="size-4" />}
          {startingSandboxId === selectedSandbox.id ? t('startingSandbox') : t('startSandbox')}</Button>
        ) : (
          <Button type="button" onClick={connectInspector} disabled={!selectedSandbox?.networkEnabled || connecting} variant="primary" size="sm">{connecting ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
          {connecting ? t('connectingInspector') : t('connectInspector')}</Button>
        )}
      </div> : null}

      {error && !availableTools.length ? (
        <pre role="alert" className="overflow-x-auto rounded-md bg-destructive/10 p-3 text-xs text-destructive">{error}</pre>
      ) : null}

      {!defaultRuntime && activeSandboxId !== sandboxId ? (
        <p className="text-sm text-muted-foreground">{t('connectInspectorHint')}</p>
      ) : availableTools.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noToolsAvailable')}</p>
      ) : (
      <div className="grid min-w-0 gap-5 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <nav aria-label={t('inspectorTools')} className="max-h-[min(24rem,50dvh)] min-w-0 space-y-1 overflow-y-auto overscroll-contain lg:sticky lg:top-4 lg:self-start">
        <p className="mb-2 text-xs font-medium text-muted-foreground">{t('inspectorTools')}</p>
        {availableTools.map((tool) => (
          <Button key={tool.name} type="button" onClick={() => onSelect(tool.name)} aria-pressed={selected === tool.name} title={tool.title ? `${tool.title} (${tool.name})` : tool.name} variant={selected === tool.name ? "secondary" : "ghost"} size="sm"><span className="truncate">{tool.title ?? tool.name}</span></Button>
        ))}
      </nav>

      <div className="min-w-0 space-y-5">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="break-all font-mono text-sm font-semibold text-foreground">{current?.name}</h3>
            {current?.annotations?.readOnlyHint ? (
              <AnimatedBadge  status="neutral" size="sm" showIcon={false}>{t('readOnlyTool')}</AnimatedBadge>
            ) : null}
            {current?.annotations?.destructiveHint ? (
              <AnimatedBadge  status="danger" size="sm" showIcon={false}>
                <AlertTriangle className="size-3" />{t('destructiveTool')}
              </AnimatedBadge>
            ) : null}
          </div>
          {current?.description ? <p className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere] text-sm leading-6 text-muted-foreground">{current.description}</p> : null}
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
          <textarea id={argumentsId} value={args} onChange={(e) => setArgs(e.target.value)} spellCheck={false} rows={Math.min(12, Math.max(5, args.split('\n').length))} className="min-h-36 w-full resize-y rounded-lg bg-muted/35 p-3 text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring max-h-[50dvh]" />
        </div>

        <Button type="button" onClick={run} disabled={loading || !selected} variant="primary" size="md">{loading ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
        {t('runTool')}</Button>

        {error ? <pre role="alert" className="overflow-x-auto rounded-md bg-destructive/10 p-3 text-xs text-destructive">{error}</pre> : null}
        {result !== null ? (
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t('toolResult')}</p>
            <pre role="status" className="max-h-96 overflow-auto rounded-md bg-muted/55 p-3 font-mono text-xs leading-5 text-foreground">{result}</pre>
          </div>
        ) : null}
        {log ? (
          <BouncyAccordion items={[{ id: 'details', title: <><Clock3 className="size-3.5" />{t('requestLog')} · {log.durationMs} ms</>, description: <><div className="mt-3 grid min-w-0 gap-4 xl:grid-cols-2">
              <div className="min-w-0">
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t('request')}</p>
                <pre className="max-h-72 overflow-auto rounded-md bg-muted/55 p-3 font-mono text-xs leading-5 text-foreground">{JSON.stringify(log.request, null, 2)}</pre>
              </div>
              <div className="min-w-0">
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t('response')}</p>
                <pre className="max-h-72 overflow-auto rounded-md bg-muted/55 p-3 font-mono text-xs leading-5 text-foreground">{JSON.stringify(log.response, null, 2)}</pre>
              </div>
            </div></> }]} />
        ) : null}
      </div>
      </div>
      )}
    </div>
  );
}
