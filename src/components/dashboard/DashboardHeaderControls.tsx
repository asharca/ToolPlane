'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useTheme } from 'next-themes';
import {
  Search,
  HelpCircle,
  Sun,
  Moon,
  Plug,
  Brain,
  Wrench,
  Boxes,
  Bot,
  BarChart3,
  Users,
  Settings,
  Store,
  Home,
  type LucideIcon,
} from 'lucide-react';
import { SITE, mailto } from '@/lib/site';

type Command = {
  id: string;
  label: string;
  group: string;
  icon: LucideIcon;
  run: () => void;
};

function workspaceSlug(pathname: string): string | null {
  const parts = pathname.split('/');
  return parts[1] === 'app' && parts[2] ? parts[2] : null;
}

export function DashboardHeaderControls() {
  const router = useRouter();
  const pathname = usePathname() ?? '';
  const { resolvedTheme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const toggleTheme = () =>
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');

  function openPalette() {
    setQuery('');
    setActive(0);
    setOpen(true);
  }

  function closePalette() {
    setOpen(false);
  }

  const commands = useMemo<Command[]>(() => {
    const slug = workspaceSlug(pathname);
    const go = (href: string) => () => {
      closePalette();
      router.push(href);
    };
    const list: Command[] = [];
    if (slug) {
      const b = `/app/${slug}`;
      list.push(
        { id: 'mcp', label: 'MCP', group: 'Manage', icon: Plug, run: go(`${b}/mcp`) },
        { id: 'skills', label: 'Skills', group: 'Manage', icon: Brain, run: go(`${b}/skills`) },
        { id: 'toolkits', label: 'Toolkits', group: 'Manage', icon: Wrench, run: go(`${b}/toolkits`) },
        { id: 'sandboxes', label: 'Sandboxes', group: 'Manage', icon: Boxes, run: go(`${b}/sandboxes`) },
        { id: 'agents', label: 'Agents', group: 'Manage', icon: Bot, run: go(`${b}/agents`) },
        { id: 'obs', label: 'Observability', group: 'Monitor', icon: BarChart3, run: go(`${b}/observability`) },
        { id: 'members', label: 'Members', group: 'Workspace', icon: Users, run: go(`${b}/members`) },
        { id: 'settings', label: 'Settings', group: 'Workspace', icon: Settings, run: go(`${b}/settings`) },
        { id: 'browse-mcp', label: 'Browse MCP', group: 'Actions', icon: Plug, run: go(`${b}/mcp/new`) },
        { id: 'browse-skills', label: 'Browse Skills', group: 'Actions', icon: Brain, run: go(`${b}/skills/new`) },
        { id: 'sell', label: 'Sell Skills', group: 'Actions', icon: Store, run: go(`${b}/seller`) },
      );
    }
    list.push(
      { id: 'home', label: 'Back to ToolPlane', group: 'Actions', icon: Home, run: go('/') },
      {
        id: 'theme',
        label: 'Toggle dark mode',
        group: 'Actions',
        icon: resolvedTheme === 'dark' ? Sun : Moon,
        run: () => {
          toggleTheme();
          closePalette();
        },
      },
    );
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, resolvedTheme, router]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(q));
  }, [commands, query]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (open) closePalette();
        else openPalette();
      } else if (e.key === 'Escape') {
        closePalette();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  function onListKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      filtered[active]?.run();
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={openPalette}
        className="relative hidden h-9 w-56 items-center rounded-md border border-border bg-muted/60 pl-8 pr-10 text-left text-sm text-muted-foreground transition-colors hover:bg-muted sm:flex"
      >
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        Search
        <kbd className="absolute right-2 top-1/2 -translate-y-1/2 rounded border border-border bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground">
          ⌘K
        </kbd>
      </button>

      <a
        href={mailto(SITE.supportEmail)}
        aria-label="Get help"
        className="ui-button-ghost ui-icon-button"
      >
        <HelpCircle className="size-4" />
      </a>

      <button
        type="button"
        aria-label="Toggle theme"
        onClick={toggleTheme}
        className="ui-button-ghost ui-icon-button"
      >
        <span aria-hidden="true">
          <Sun className="hidden size-4 dark:block" />
          <Moon className="size-4 dark:hidden" />
        </span>
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh]"
          onClick={closePalette}
        >
          <div
            role="dialog"
            aria-label="Command palette"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900"
          >
            <div className="flex items-center gap-2 border-b border-zinc-200 px-3 dark:border-zinc-700">
              <Search className="size-4 text-muted-foreground" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onListKey}
                placeholder="Type a command or search…"
                className="h-12 w-full bg-transparent text-sm text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100"
              />
            </div>
            <ul className="max-h-80 overflow-y-auto p-1.5">
              {filtered.length === 0 ? (
                <li className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No results
                </li>
              ) : (
                filtered.map((c, i) => {
                  const Icon = c.icon;
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        onMouseEnter={() => setActive(i)}
                        onClick={() => c.run()}
                        className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                          i === active
                            ? 'bg-brand-soft text-accent-foreground'
                            : 'text-muted-foreground'
                        }`}
                      >
                        <Icon className="size-4 shrink-0 text-muted-foreground" />
                        <span className="flex-1">{c.label}</span>
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          {c.group}
                        </span>
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
          </div>
        </div>
      ) : null}
    </>
  );
}
