import Link from 'next/link';

export type Tab = { key: string; label: string; count?: number };

export function TabBar({
  tabs,
  current,
  basePath,
}: {
  tabs: Tab[];
  current: string;
  basePath: string;
}) {
  return (
    <div className="max-w-full overflow-x-auto pb-1">
      <div className="inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-zinc-100 p-1 dark:border-zinc-800 dark:bg-zinc-900">
        {tabs.map((tab) => {
          const active = tab.key === current;
          const href =
            tab.key === tabs[0]?.key ? basePath : `${basePath}?tab=${tab.key}`;
          return (
            <Link
              key={tab.key}
              href={href}
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                active
                  ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
              }`}
            >
              {tab.label}
              {typeof tab.count === 'number' ? (
                <span className="text-zinc-400 dark:text-zinc-500">
                  {tab.count}
                </span>
              ) : null}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
