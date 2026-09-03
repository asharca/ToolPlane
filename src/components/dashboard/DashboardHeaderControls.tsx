'use client';

import { useTranslations } from 'next-intl';
import { type ComponentType, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
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
  Code2,
  Users,
  Home,
  MessageSquare,
  Settings,
  TerminalSquare,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/Dialog';
import { SITE, mailto } from '@/lib/site';
import { useDashboardRuntimeConfig } from './DashboardRuntimeConfig';
import { SystemUpdateButton } from './SystemUpdateButton';

type Command = {
  id: string;
  label: string;
  group: string;
  icon: ComponentType<{ className?: string }>;
  run: () => void;
};

function workspaceSlug(pathname: string): string | null {
  const parts = pathname.split('/');
  return parts[1] === 'app' && parts[2] ? parts[2] : null;
}

export function DashboardHeaderControls({ canInstall = false }: { canInstall?: boolean }) {
  const t = useTranslations('console.header');
  const router = useRouter();
  const pathname = usePathname() ?? '';
  const searchParams = useSearchParams();
  const queryString = searchParams.toString();
  const returnTo = `${pathname}${queryString ? `?${queryString}` : ''}`;
  const { resolvedTheme, setTheme } = useTheme();
  const { supportEmail } = useDashboardRuntimeConfig();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const toggleTheme = useCallback(() => {
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
  }, [resolvedTheme, setTheme]);

  function openPalette() {
    setQuery('');
    setActive(0);
    setOpen(true);
  }

  const closePalette = useCallback(() => {
    setOpen(false);
  }, []);

  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen) openPalette();
    else closePalette();
  }

  const commands = useMemo<Command[]>(() => {
    const slug = workspaceSlug(pathname);
    const go = (href: string) => () => {
      closePalette();
      router.push(href);
    };
    const openExternal = (href: string) => () => {
      closePalette();
      window.open(href, '_blank', 'noopener,noreferrer');
    };
    const list: Command[] = [];
    if (slug) {
      const b = `/app/${slug}`;
      list.push(
        { id: 'mcp', label: t('mcp'), group: t('groupBuild'), icon: Plug, run: go(`${b}/mcp`) },
        { id: 'skills', label: t('skills'), group: t('groupBuild'), icon: Brain, run: go(`${b}/skills`) },
        { id: 'toolkits', label: t('toolkits'), group: t('groupBuild'), icon: Wrench, run: go(`${b}/toolkits`) },
        { id: 'sandboxes', label: t('sandboxes'), group: t('groupBuild'), icon: Boxes, run: go(`${b}/sandboxes`) },
        { id: 'chat', label: t('chat'), group: t('groupRun'), icon: MessageSquare, run: go(`${b}/chat`) },
        { id: 'work', label: t('work'), group: t('groupRun'), icon: TerminalSquare, run: go(`${b}/work`) },
        { id: 'obs', label: t('logs'), group: t('groupOperate'), icon: BarChart3, run: go(`${b}/observability`) },
        { id: 'members', label: t('members'), group: t('groupWorkspace'), icon: Users, run: go(`${b}/members`) },
        { id: 'settings', label: t('settings'), group: t('groupWorkspace'), icon: Settings, run: go(`${b}/settings?returnTo=${encodeURIComponent(returnTo)}`) },
        { id: 'browse-mcp', label: t('browseMcp'), group: t('groupDiscover'), icon: Plug, run: go(`${b}/market/mcp`) },
        { id: 'browse-skills', label: t('browseSkills'), group: t('groupDiscover'), icon: Brain, run: go(`${b}/market/skills`) },
        { id: 'browse-agents', label: t('browseAgents'), group: t('groupDiscover'), icon: Bot, run: go(`${b}/market/agents`) },
        { id: 'browse-toolkits', label: t('browseToolkits'), group: t('groupDiscover'), icon: Wrench, run: go(`${b}/market/toolkits`) },
      );
    }
    list.push(
      { id: 'home', label: t('backToToolPlane'), group: t('groupActions'), icon: Home, run: go('/') },
      { id: 'source', label: t('sourceCode'), group: t('groupProject'), icon: Code2, run: openExternal(SITE.sourceUrl) },
      {
        id: 'theme',
        label: t('toggleDarkMode'),
        group: t('groupActions'),
        icon: resolvedTheme === 'dark' ? Sun : Moon,
        run: () => {
          toggleTheme();
          closePalette();
        },
      },
    );
    return list;
  }, [closePalette, pathname, resolvedTheme, returnTo, router, t, toggleTheme]);

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
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [closePalette, open]);

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
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogTrigger asChild>
          <button
            type="button"
            aria-label={t('quickNavigation')}
            title={t('quickNavigation')}
            className="ui-button-ghost ui-icon-button"
          >
            <Search className="size-4" />
          </button>
        </DialogTrigger>

        <DialogPortal>
          <DialogOverlay className="!bg-black/40" />
          <DialogContent
            aria-describedby={undefined}
            className="!top-[12vh] !block !max-h-none !translate-y-0 !gap-0 !overflow-hidden !rounded-2xl !border-border !bg-popover !p-0 !text-popover-foreground !shadow-2xl sm:!p-0"
          >
            <DialogTitle className="sr-only">{t('commandPalette')}</DialogTitle>
            <div className="flex items-center gap-2 border-b border-border px-3">
              <Search className="size-4 text-muted-foreground" />
              <input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onListKey}
                placeholder={t('searchNavigation')}
                className="h-12 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>
            <ul className="max-h-80 overflow-y-auto p-1.5">
              {filtered.length === 0 ? (
                <li className="px-3 py-6 text-center text-sm text-muted-foreground">
                  {t('noResults')}
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
                        className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                          i === active
                            ? 'bg-brand-soft text-foreground ring-1 ring-brand/10'
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
          </DialogContent>
        </DialogPortal>
      </Dialog>

      <SystemUpdateButton canInstall={canInstall} />

      <a
        href={mailto(supportEmail)}
        aria-label={t('getHelp')}
        className="ui-button-ghost ui-icon-button"
      >
        <HelpCircle className="size-4" />
      </a>

    </>
  );
}
