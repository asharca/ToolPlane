'use client';
import { CopyButton } from './CopyButton';
import { AgentCode } from '@/components/agents/agent-code';

function pretty(value: string): string {
  try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
}

export function LogPayload({ label, value, copyLabel, unavailableText }: {
  label: string; value: string | null; copyLabel: string; unavailableText: string;
}) {
  const formatted = value === null ? null : pretty(value);
  return <div className="min-w-0">
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs font-semibold text-muted-foreground">{label}</p>
      {formatted !== null ? <CopyButton text={formatted} label={copyLabel} /> : null}
    </div>
    {formatted !== null ? <div className="max-h-96 overflow-auto rounded-md border border-border bg-background p-3" tabIndex={0} aria-label={label}>
      <AgentCode code={formatted} language="json" />
    </div> : <p className="text-sm text-muted-foreground">{unavailableText}</p>}
  </div>;
}
