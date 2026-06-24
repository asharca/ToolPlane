import { Bot, Workflow, Network, Sparkles } from 'lucide-react';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';

export const dynamic = 'force-dynamic';

const PREVIEW = [
  {
    icon: Workflow,
    title: 'Compose agents',
    body: 'Chain MCP servers and skills into multi-step agent workflows.',
  },
  {
    icon: Network,
    title: 'Route between tools',
    body: 'Let an orchestrator pick the right tool for each task automatically.',
  },
  {
    icon: Sparkles,
    title: 'Run on a schedule',
    body: 'Trigger agents on events or cron and watch them in Observability.',
  },
];

export default function AgentsPage() {
  return (
    <>
      <DashboardHeader title="Agents" />
      <div className="px-8 py-6">
        <div className="rounded-xl border border-zinc-200 bg-gradient-to-b from-zinc-50 to-white p-10 text-center dark:border-zinc-800 dark:from-zinc-900 dark:to-zinc-950">
          <span className="mx-auto flex size-12 items-center justify-center rounded-xl bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900">
            <Bot className="size-6" />
          </span>
          <span className="mt-4 inline-block rounded bg-sky-100 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-sky-700 dark:bg-sky-500/15 dark:text-sky-300">
            Coming soon
          </span>
          <h2 className="mt-3 text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
            Agent orchestration
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-zinc-500 dark:text-zinc-400">
            Turn the MCP servers and skills in this workspace into autonomous
            agents. Here&apos;s what&apos;s on the way.
          </p>
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          {PREVIEW.map((f) => {
            const Icon = f.icon;
            return (
              <div
                key={f.title}
                className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-800"
              >
                <Icon className="size-5 text-zinc-500 dark:text-zinc-400" />
                <h3 className="mt-3 font-medium text-zinc-900 dark:text-zinc-100">
                  {f.title}
                </h3>
                <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                  {f.body}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
