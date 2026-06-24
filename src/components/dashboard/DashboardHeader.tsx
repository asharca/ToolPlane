import { Search, HelpCircle, Sun } from 'lucide-react';
import type { ReactNode } from 'react';

export function DashboardHeader({
  title,
  actions,
}: {
  title: string;
  actions?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/95 backdrop-blur">
      <div className="flex h-16 items-center justify-between gap-4 px-8">
        <h1 className="text-2xl font-bold tracking-tight text-zinc-900">
          {title}
        </h1>
        <div className="flex items-center gap-2">
          <div className="relative hidden sm:block">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
            <input
              disabled
              placeholder="Search"
              className="h-9 w-56 rounded-md border border-zinc-200 bg-zinc-50 pl-8 pr-10 text-sm text-zinc-700 placeholder:text-zinc-400"
            />
            <kbd className="absolute right-2 top-1/2 -translate-y-1/2 rounded border border-zinc-200 bg-white px-1.5 py-0.5 text-[10px] text-zinc-400">
              ⌘K
            </kbd>
          </div>
          <button
            type="button"
            className="inline-flex size-9 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-100"
          >
            <HelpCircle className="size-4" />
          </button>
          <button
            type="button"
            className="inline-flex size-9 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-100"
          >
            <Sun className="size-4" />
          </button>
          {actions}
        </div>
      </div>
    </header>
  );
}
