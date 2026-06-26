'use client';

import { Fragment, useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';

export type LogEntry = {
  id: string;
  time: string;
  method: string;
  tool?: string;
  statusCode: number;
  durationMs: number;
  request: string | null;
  response: string | null;
};

function pretty(s: string | null): string {
  if (!s) return '—';
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

const cell = 'px-4 py-2 text-xs';

export function DeploymentLogs({ logs }: { logs: LogEntry[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="max-h-[32rem] overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
      <table className="w-full text-left text-sm">
        <thead className="sticky top-0 z-10 border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          <tr>
            <th className="w-8 px-2 py-2.5" />
            <th className="px-4 py-2.5 font-medium">Time</th>
            <th className="px-4 py-2.5 font-medium">Call</th>
            <th className="px-4 py-2.5 font-medium">Status</th>
            <th className="px-4 py-2.5 text-right font-medium">Latency</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {logs.map((l) => {
            const isOpen = open.has(l.id);
            const ok = l.statusCode < 400;
            const hasDetail = Boolean(l.request || l.response);
            return (
              <Fragment key={l.id}>
                <tr
                  onClick={() => hasDetail && toggle(l.id)}
                  className={`${hasDetail ? 'cursor-pointer' : ''} hover:bg-zinc-50 dark:hover:bg-zinc-900/50`}
                >
                  <td className="px-2 py-2 text-zinc-400">
                    {hasDetail ? (
                      isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />
                    ) : null}
                  </td>
                  <td className={`${cell} whitespace-nowrap text-zinc-500 dark:text-zinc-400`}>{l.time}</td>
                  <td className={`${cell} font-mono text-zinc-700 dark:text-zinc-300`}>
                    {l.method}
                    {l.tool ? <span className="text-zinc-400 dark:text-zinc-500"> · {l.tool}</span> : null}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`font-mono text-xs ${
                        ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
                      }`}
                    >
                      {l.statusCode}
                    </span>
                  </td>
                  <td className={`${cell} text-right text-zinc-500 dark:text-zinc-400`}>{l.durationMs}ms</td>
                </tr>
                {isOpen ? (
                  <tr className="bg-zinc-50/60 dark:bg-zinc-900/40">
                    <td />
                    <td colSpan={4} className="px-4 py-3">
                      <div className="grid gap-3 md:grid-cols-2">
                        <div>
                          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Request</p>
                          <pre className="max-h-64 overflow-auto rounded-md border border-zinc-200 bg-white p-3 font-mono text-[11px] leading-relaxed text-zinc-700 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
                            {pretty(l.request)}
                          </pre>
                        </div>
                        <div>
                          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Response</p>
                          <pre className="max-h-64 overflow-auto rounded-md border border-zinc-200 bg-white p-3 font-mono text-[11px] leading-relaxed text-zinc-700 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
                            {pretty(l.response)}
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
