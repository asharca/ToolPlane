'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Cable, Container, FolderOpen, Globe2, Network, Plus, Server, type LucideIcon } from 'lucide-react';
import { createSandboxAction } from '@/lib/sandboxes/actions';

type Mode = 'docker' | 'connector';

const inputClass = 'ui-input h-9 w-full';

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

function Field({
  label,
  children,
  className,
  hint,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  hint?: string;
}) {
  return (
    <label className={cx('space-y-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground', className)}>
      {label}
      {children}
      {hint ? <span className="block text-[11px] font-normal normal-case leading-4 tracking-normal text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

function ModeButton({
  active,
  icon: Icon,
  title,
  description,
  onClick,
}: {
  active: boolean;
  icon: LucideIcon;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        'group flex min-h-20 items-start gap-3 rounded-md border px-3 py-3 text-left transition-colors',
        active
          ? 'border-brand bg-brand-soft text-accent-foreground'
          : 'border-border bg-background text-foreground hover:border-ring/60 hover:bg-muted/50',
      )}
    >
      <span
        className={cx(
          'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border',
          active ? 'border-brand/30 bg-background text-brand' : 'border-border bg-muted text-muted-foreground',
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold">{title}</span>
        <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}

export function SandboxCreateForm({
  workspace,
  defaultImage,
  connectorServerUrl,
  defaultRemoteRoot,
}: {
  workspace: string;
  defaultImage: string;
  connectorServerUrl: string;
  defaultRemoteRoot: string;
}) {
  const [mode, setMode] = useState<Mode>('docker');
  const isDocker = mode === 'docker';

  return (
    <form action={createSandboxAction} className="space-y-5">
      <input type="hidden" name="workspace" value={workspace} />
      <input type="hidden" name="kind" value={mode} />

      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(20rem,1.5fr)]">
        <Field label="Name">
          <input name="name" placeholder={isDocker ? 'Research container' : 'My laptop'} className={inputClass} />
        </Field>
        <div className="grid gap-2 sm:grid-cols-2">
          <ModeButton
            active={isDocker}
            icon={Container}
            title="Docker container"
            description="Managed Linux workspace with a persistent volume."
            onClick={() => setMode('docker')}
          />
          <ModeButton
            active={!isDocker}
            icon={Cable}
            title="User connector"
            description="User runs one npx command; the CLI connects back over WebSocket."
            onClick={() => setMode('connector')}
          />
        </div>
      </div>

      {isDocker ? (
        <div className="grid gap-3 border-t border-border pt-4 md:grid-cols-[minmax(0,1fr)_14rem_auto]">
          <Field label="Container image" hint="Used to create the managed Linux workspace.">
            <div className="relative">
              <Server className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input name="image" defaultValue={defaultImage} className="ui-input ui-input-icon h-9 w-full" />
            </div>
          </Field>
          <Field label="Network">
            <div className="relative">
              <Network className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <select name="network" defaultValue="isolated" className="ui-input ui-input-icon h-9 w-full">
                <option value="isolated">Isolated</option>
                <option value="none">None</option>
              </select>
            </div>
          </Field>
          <div className="flex items-end">
            <button className="ui-button-primary h-9 w-full md:w-auto">
              <Plus className="size-4" />
              Create container
            </button>
          </div>
        </div>
      ) : (
        <div className="grid gap-3 border-t border-border pt-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <Field label="Platform URL" hint="The connector uses this to discover the WebSocket broker.">
            <div className="relative">
              <Globe2 className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input name="connectorServerUrl" defaultValue={connectorServerUrl} className="ui-input ui-input-icon h-9 w-full" />
            </div>
          </Field>
          <Field label="Local root" hint="Directory on the user's machine exposed to the agent.">
            <div className="relative">
              <FolderOpen className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input name="connectorRemoteRoot" defaultValue={defaultRemoteRoot} className="ui-input ui-input-icon h-9 w-full" />
            </div>
          </Field>
          <div className="flex items-end">
            <button className="ui-button-primary h-9 w-full md:w-auto">
              <Plus className="size-4" />
              Create connector
            </button>
          </div>
        </div>
      )}
    </form>
  );
}
