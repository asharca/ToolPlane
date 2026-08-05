'use client';

import Link from 'next/link';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Fragment, useState } from 'react';

export type ObservabilityLogView = {
  id: string;
  deploymentId: string | null;
  deploymentHref: string | null;
  deploymentName: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  requestBody: string | null;
  responseBody: string | null;
  time: string;
};

function pretty(value: string | null): string {
  if (!value) return '—';
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

export function ObservabilityLogs({
  logs,
  labels,
}: {
  logs: ObservabilityLogView[];
  labels: {
    expand: string;
    collapse: string;
    server: string;
    path: string;
    method: string;
    status: string;
    duration: string;
    time: string;
    request: string;
    response: string;
    openServer: string;
  };
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="max-h-[42rem] overflow-auto rounded-lg border border-border">
      <table className="w-full min-w-[68rem] text-left text-sm">
        <thead className="sticky top-0 z-10 border-b border-border bg-muted/95 text-xs uppercase tracking-wide text-muted-foreground backdrop-blur">
          <tr>
            <th className="w-10 px-3 py-3" />
            <th className="px-4 py-3 font-medium">{labels.time}</th>
            <th className="px-4 py-3 font-medium">{labels.server}</th>
            <th className="px-4 py-3 font-medium">{labels.method}</th>
            <th className="max-w-[28rem] px-4 py-3 font-medium">{labels.path}</th>
            <th className="px-4 py-3 font-medium">{labels.status}</th>
            <th className="px-4 py-3 text-right font-medium">{labels.duration}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {logs.map((log) => {
            const expanded = open.has(log.id);
            const hasDetails = Boolean(log.requestBody || log.responseBody);
            const ok = log.statusCode < 400;
            return (
              <Fragment key={log.id}>
                <tr className="group hover:bg-muted/40">
                  <td className="px-3 py-2.5">
                    {hasDetails ? (
                      <button
                        type="button"
                        onClick={() => toggle(log.id)}
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                        aria-label={expanded ? labels.collapse : labels.expand}
                      >
                        {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                      </button>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted-foreground">{log.time}</td>
                  <td className="max-w-56 px-4 py-2.5">
                    {log.deploymentHref ? (
                      <Link
                        href={log.deploymentHref}
                        className="block truncate font-medium text-foreground hover:underline"
                        title={labels.openServer}
                      >
                        {log.deploymentName}
                      </Link>
                    ) : (
                      <span className="font-medium text-foreground">{log.deploymentName}</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-foreground">{log.method}</td>
                  <td className="max-w-[28rem] truncate px-4 py-2.5 font-mono text-xs text-muted-foreground" title={log.path}>
                    {log.path}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-flex rounded-full px-2 py-0.5 font-mono text-xs font-semibold ${
                      ok
                        ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                        : 'bg-red-500/10 text-red-700 dark:text-red-400'
                    }`}>
                      {log.statusCode}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right text-xs text-muted-foreground">
                    {log.durationMs}ms
                  </td>
                </tr>
                {expanded ? (
                  <tr className="bg-muted/20">
                    <td />
                    <td colSpan={6} className="px-4 py-3">
                      <div className="grid gap-3 md:grid-cols-2">
                        <div>
                          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                            {labels.request}
                          </p>
                          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background p-3 font-mono text-[11px] leading-relaxed text-foreground">
                            {pretty(log.requestBody)}
                          </pre>
                        </div>
                        <div>
                          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                            {labels.response}
                          </p>
                          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background p-3 font-mono text-[11px] leading-relaxed text-foreground">
                            {pretty(log.responseBody)}
                          </pre>
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
