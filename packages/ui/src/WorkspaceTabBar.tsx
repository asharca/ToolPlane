'use client';

import { ExternalLink, Pin, Plus, X } from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type DragEvent,
  type MouseEvent,
  type Ref,
  type ReactNode,
} from 'react';

type Icon = ComponentType<{ className?: string }>;

export type WorkspaceTab = {
  id: string;
  icon: Icon;
  label: string;
  pinned: boolean;
};

export type WorkspaceTabBarLabels = {
  close: (label: string) => string;
  navigation: string;
  newTab: string;
  openInNewWindow: (label: string) => string;
  pin: (label: string) => string;
  unpin: (label: string) => string;
};

export const workspaceTabBarDefaultLabels: WorkspaceTabBarLabels = {
  close: (label) => `Close ${label}`,
  navigation: 'Open pages',
  newTab: 'New tab',
  openInNewWindow: (label) => `Open ${label} in new window`,
  pin: (label) => `Pin ${label}`,
  unpin: (label) => `Unpin ${label}`,
};

export type WorkspaceTabBarProps = {
  actions?: ReactNode;
  activeTabId: string;
  labels?: Partial<WorkspaceTabBarLabels>;
  onClose: (id: string) => void;
  onNewTab: () => void;
  onOpenInNewWindow: (id: string) => void;
  onReorder: (sourceId: string, targetId: string) => void;
  onSelect: (id: string) => void;
  onTogglePinned: (id: string) => void;
  tabs: WorkspaceTab[];
};

export function WorkspaceTabBar({
  actions,
  activeTabId,
  labels: labelsOverride,
  onClose,
  onNewTab,
  onOpenInNewWindow,
  onReorder,
  onSelect,
  onTogglePinned,
  tabs,
}: WorkspaceTabBarProps) {
  const labels = { ...workspaceTabBarDefaultLabels, ...labelsOverride };
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId, tabs.length]);

  return (
    <nav
      aria-label={labels.navigation}
      data-toolplane-ui="workspace-tab-bar"
      className="flex h-11 shrink-0 bg-shell px-2"
    >
      <ol className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1 [&::-webkit-scrollbar]:hidden">
        {tabs.map((tab) => (
          <WorkspaceTabButton
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            canClose={tabs.length > 1}
            draggingId={draggingId}
            labels={labels}
            onClose={onClose}
            onDragChange={setDraggingId}
            onNewWindow={onOpenInNewWindow}
            onReorder={onReorder}
            onSelect={onSelect}
            onTogglePinned={onTogglePinned}
            activeButtonRef={tab.id === activeTabId ? activeRef : undefined}
          />
        ))}
        <li className="shrink-0">
          <button
            type="button"
            aria-label={labels.newTab}
            title={labels.newTab}
            onClick={onNewTab}
            className="ui-button-ghost ui-icon-button"
          >
            <Plus className="size-4" />
          </button>
        </li>
      </ol>
      {actions}
    </nav>
  );
}

type WorkspaceTabButtonProps = {
  active: boolean;
  activeButtonRef?: Ref<HTMLButtonElement>;
  canClose: boolean;
  draggingId: string | null;
  labels: WorkspaceTabBarLabels;
  onClose: (id: string) => void;
  onDragChange: (id: string | null) => void;
  onNewWindow: (id: string) => void;
  onReorder: (sourceId: string, targetId: string) => void;
  onSelect: (id: string) => void;
  onTogglePinned: (id: string) => void;
  tab: WorkspaceTab;
};

function WorkspaceTabButton({
  active,
  activeButtonRef,
  canClose,
  draggingId,
  labels,
  onClose,
  onDragChange,
  onNewWindow,
  onReorder,
  onSelect,
  onTogglePinned,
  tab,
}: WorkspaceTabButtonProps) {
  const dragAllowed = Boolean(draggingId && draggingId !== tab.id);
  const controls = active || draggingId === tab.id;
  const stop = (event: MouseEvent<HTMLButtonElement>) => event.stopPropagation();
  const Icon = tab.icon;

  return (
    <li
      data-tab-id={tab.id}
      data-active={active ? 'true' : undefined}
      draggable
      onDragEnd={() => onDragChange(null)}
      onDragStart={(event: DragEvent<HTMLLIElement>) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', tab.id);
        onDragChange(tab.id);
      }}
      onDragOver={(event) => {
        if (!dragAllowed) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      }}
      onDrop={(event) => {
        if (!draggingId || draggingId === tab.id) return;
        event.preventDefault();
        onReorder(draggingId, tab.id);
        onDragChange(null);
      }}
      className={`group flex h-[30px] min-w-24 max-w-56 shrink-0 items-center rounded-[10px] transition-[background-color,color,transform] duration-150 ${active ? 'bg-background text-foreground ring-1 ring-border/70' : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground'} ${draggingId === tab.id ? 'scale-[0.98] opacity-50' : ''}`}
    >
      <button
        ref={activeButtonRef}
        type="button"
        aria-current={active ? 'page' : undefined}
        title={tab.label}
        onAuxClick={(event) => {
          if (event.button === 1) onClose(tab.id);
        }}
        onClick={() => onSelect(tab.id)}
        onDoubleClick={() => onClose(tab.id)}
        className="flex min-w-0 flex-1 items-center gap-1.5 px-2 text-left text-xs"
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{tab.label}</span>
      </button>
      <div className="mr-1 flex shrink-0 items-center">
        <button
          type="button"
          aria-pressed={tab.pinned}
          aria-label={tab.pinned ? labels.unpin(tab.label) : labels.pin(tab.label)}
          title={tab.pinned ? labels.unpin(tab.label) : labels.pin(tab.label)}
          onClick={(event) => {
            stop(event);
            onTogglePinned(tab.id);
          }}
          className={`flex size-[18px] items-center justify-center rounded-sm transition-colors hover:bg-foreground/10 ${tab.pinned ? (controls ? 'bg-brand-soft text-accent-foreground' : 'bg-brand-soft/50 text-accent-foreground/60 group-hover:bg-brand-soft group-hover:text-accent-foreground group-focus-within:bg-brand-soft group-focus-within:text-accent-foreground') : (controls ? '' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100')}`}
        >
          <Pin className={`size-3 ${tab.pinned ? 'fill-current' : ''}`} />
        </button>
        <div className={`flex items-center transition-opacity ${controls ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'}`}>
          <button
            type="button"
            aria-label={labels.openInNewWindow(tab.label)}
            title={labels.openInNewWindow(tab.label)}
            onClick={(event) => {
              stop(event);
              onNewWindow(tab.id);
            }}
            className="flex size-[18px] items-center justify-center rounded-sm hover:bg-foreground/10"
          >
            <ExternalLink className="size-3" />
          </button>
          {canClose ? (
            <button
              type="button"
              aria-label={labels.close(tab.label)}
              title={labels.close(tab.label)}
              onClick={(event) => {
                stop(event);
                onClose(tab.id);
              }}
              className="flex size-[18px] items-center justify-center rounded-sm hover:bg-foreground/10"
            >
              <X className="size-3" />
            </button>
          ) : null}
        </div>
      </div>
    </li>
  );
}
