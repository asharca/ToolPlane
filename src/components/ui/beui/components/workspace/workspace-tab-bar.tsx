"use client";

import { ArrowLeft, ArrowRight, ExternalLink, MoreHorizontal, Pin, PinOff, Plus, X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../motion/button/base";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from "../motion/context-menu";
import { MorphPopover, MorphPopoverTrigger, MorphPopoverContent } from "../motion/popover-morph";
import { SPRING_LAYOUT } from "../../lib/ease";
import { cn } from "../../lib/utils";

export interface WorkspaceTab {
  id: string;
  title: string;
  icon?: ReactNode;
  pinned?: boolean;
  dirty?: boolean;
  closable?: boolean;
  detachable?: boolean;
  tabId?: string;
  panelId?: string;
}
export interface WorkspaceTabBarLabels {
  navigation: string;
  newTab: string;
  close: (title: string) => string;
  pin: (title: string) => string;
  unpin: (title: string) => string;
  openInNewWindow: (title: string) => string;
  actions: (title: string) => string;
  menu: (title: string) => string;
  moveLeft: string;
  moveRight: string;
  unsaved: string;
}
const defaultLabels: WorkspaceTabBarLabels = {
  navigation: "Open pages", newTab: "New tab", close: title => `Close ${title}`,
  pin: title => `Pin ${title}`, unpin: title => `Unpin ${title}`,
  openInNewWindow: title => `Open ${title} in new window`, actions: title => `${title} actions`,
  menu: title => `${title} tab menu`, moveLeft: "Move left", moveRight: "Move right", unsaved: "(unsaved)",
};
export interface WorkspaceTabBarProps {
  labels?: Partial<WorkspaceTabBarLabels>;
  /** Keep frequently used actions visible, including on touch screens. */
  quickActions?: boolean;
  tabs: WorkspaceTab[];
  activeTabId: string;
  onSelect: (id: string) => void;
  onClose?: (id: string) => void;
  onReorder?: (sourceId: string, targetId: string) => void;
  onPinnedChange?: (id: string, pinned: boolean) => void;
  onOpenInNewWindow?: (id: string) => void;
  onNewTab?: () => void;
  actions?: ReactNode;
  closeOnMiddleClick?: boolean;
  closeOnDoubleClick?: boolean;
  className?: string;
}
interface TabAction { key: string; label: string; icon: ReactNode; disabled?: boolean; run: () => void }

function TabActions({ label, items, restore }: { label: string; items: TabAction[]; restore: () => void }) {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    // beUI portals mount in an effect. Wait one frame for the actual actions.
    const frame = requestAnimationFrame(() => panel.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);
  return <MorphPopover open={open} onOpenChange={setOpen}>
    <MorphPopoverTrigger><Button variant="ghost" size="icon" className="size-6 rounded-md" aria-label={label}><MoreHorizontal className="size-3.5" /></Button></MorphPopoverTrigger>
    <MorphPopoverContent align="end" radius={10} className="w-48 p-1">
      <div ref={panel} inert={!open}>
        {items.map((item) => <Button key={item.key} variant="ghost" size="sm" disabled={item.disabled} className="w-full justify-start rounded-md px-2 text-xs"
          onClick={() => { item.run(); setOpen(false); restore(); }}>{item.icon}{item.label}</Button>)}
      </div>
    </MorphPopoverContent>
  </MorphPopover>;
}

/** Browser-like tabs joined to the content surface. Only the selected surface
 * moves; controls stay in place. Selection/order/dirty confirmation are host-owned.
 */
export function WorkspaceTabBar({ tabs, activeTabId, onSelect, onClose, onReorder, onPinnedChange, onOpenInNewWindow, onNewTab, actions, closeOnMiddleClick = true, closeOnDoubleClick = false, className, labels: labelOverrides, quickActions = false }: WorkspaceTabBarProps) {
  const labels = { ...defaultLabels, ...labelOverrides };
  const instance = useId();
  const reduce = useReducedMotion();
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const scroller = useRef<HTMLDivElement>(null);
  const closing = useRef<string | null>(null);
  const currentId = tabs.some((tab) => tab.id === activeTabId) ? activeTabId : tabs[0]?.id;
  const canClose = (tab: WorkspaceTab) => Boolean(onClose && !tab.pinned && tab.closable !== false && tabs.length > 1);
  const restore = (id: string) => (refs.current.get(id) ?? refs.current.get(currentId) ?? refs.current.get(tabs[0]?.id))?.focus({ preventScroll: true });
  useLayoutEffect(() => {
    if (closing.current && !tabs.some((tab) => tab.id === closing.current)) {
      closing.current = null;
      (refs.current.get(currentId) ?? refs.current.get(tabs[0]?.id))?.focus({ preventScroll: true });
    }
    const node = scroller.current;
    const active = refs.current.get(currentId)?.closest<HTMLElement>("[data-slot='workspace-tab']");
    if (!node || !active) return;
    const bounds = node.getBoundingClientRect();
    const rect = active.getBoundingClientRect();
    if (rect.left < bounds.left) node.scrollLeft += rect.left - bounds.left;
    else if (rect.right > bounds.right) node.scrollLeft += rect.right - bounds.right;
  }, [currentId, tabs]);
  const close = (tab: WorkspaceTab) => { if (canClose(tab)) { closing.current = tab.id; onClose?.(tab.id); } };
  const move = (tab: WorkspaceTab, target?: WorkspaceTab) => {
    if (!target || tab.id === target.id || Boolean(tab.pinned) !== Boolean(target.pinned)) return;
    onReorder?.(tab.id, target.id);
    restore(tab.id);
  };
  const selectAt = (index: number) => {
    const tab = tabs[(index + tabs.length) % tabs.length];
    if (tab) { onSelect(tab.id); restore(tab.id); }
  };
  const menuItems = (tab: WorkspaceTab, index: number) => {
    const items: TabAction[] = [];
    if (onOpenInNewWindow) items.push({ key: "detach", label: labels.openInNewWindow(tab.title), icon: <ExternalLink className="size-3.5" />, disabled: tab.detachable === false, run: () => onOpenInNewWindow(tab.id) });
    if (onPinnedChange) items.push({ key: "pin", label: tab.pinned ? labels.unpin(tab.title) : labels.pin(tab.title), icon: tab.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />, run: () => onPinnedChange(tab.id, !tab.pinned) });
    if (onReorder) {
      items.push({ key: "left", label: labels.moveLeft, icon: <ArrowLeft className="size-3.5" />, disabled: !tabs[index - 1] || Boolean(tabs[index - 1].pinned) !== Boolean(tab.pinned), run: () => move(tab, tabs[index - 1]) });
      items.push({ key: "right", label: labels.moveRight, icon: <ArrowRight className="size-3.5" />, disabled: !tabs[index + 1] || Boolean(tabs[index + 1].pinned) !== Boolean(tab.pinned), run: () => move(tab, tabs[index + 1]) });
    }
    if (onClose) items.push({ key: "close", label: labels.close(tab.title), icon: <X className="size-3.5" />, disabled: !canClose(tab), run: () => close(tab) });
    return items;
  };
  return <nav aria-label={labels.navigation} data-ui-engine="beui" data-toolplane-ui="workspace-tab-bar" data-slot="workspace-tab-strip" data-leading-active={tabs[0]?.id === currentId} className={cn("flex h-11 max-w-full min-w-0 shrink-0 items-end", className)}>
    <motion.div layoutScroll ref={scroller} data-slot="workspace-tab-bar" className="min-w-0 flex-1 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {/* Each tab owns sibling action buttons; never put controls inside a tab button. */}
      <div role="tablist" aria-label={labels.navigation} className="flex h-11 min-w-max items-end gap-1 pt-1">
        {/* eslint-disable-next-line react-hooks/refs -- Action closures access refs only after user interaction; rendering does not dereference them. */}
        {tabs.map((tab, index) => {
          const selected = tab.id === currentId;
          const items = menuItems(tab, index);
          return <ContextMenu key={tab.id}>
            <ContextMenuTrigger disabled={!items.length}>
              {/* biome-ignore lint/a11y/useSemanticElements: This groups a tab and sibling actions, not form fields. */}
              <div role="group" aria-label={labels.actions(tab.title)} data-slot="workspace-tab" data-tab-key={tab.id} data-tab-id={tab.id} data-active={selected} tabIndex={-1}
                draggable={Boolean(onReorder)}
                onDragStart={(event) => { event.dataTransfer.setData("text/plain", `${instance}:${tab.id}`); event.dataTransfer.effectAllowed = "move"; }}
                onDragOver={(event) => { if (onReorder) event.preventDefault(); }}
                onDrop={(event) => { event.preventDefault(); const key = event.dataTransfer.getData("text/plain"); const source = tabs.find((item) => `${instance}:${item.id}` === key); if (source) move(source, tab); }}
                className="group relative isolate flex h-10 shrink-0 items-center rounded-t-[var(--workspace-radius,0.75rem)] px-1 pb-0.5 outline-none">
                {selected && <motion.span aria-hidden="true" data-slot="workspace-tab-selection" initial={false}
                  layoutId={reduce ? undefined : `${instance}-surface`} transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
                  className={cn("pointer-events-none absolute inset-0 -z-10 rounded-t-[var(--workspace-radius,0.75rem)] bg-[var(--workspace-surface,var(--background))] after:absolute after:-right-2 after:bottom-0 after:size-2 after:bg-[radial-gradient(circle_at_top_right,transparent_70%,var(--workspace-surface,var(--background))_72%)]", index > 0 && "before:absolute before:-left-2 before:bottom-0 before:size-2 before:bg-[radial-gradient(circle_at_top_left,transparent_70%,var(--workspace-surface,var(--background))_72%)]")} />}
                <button ref={(node) => { if (node) refs.current.set(tab.id, node); else refs.current.delete(tab.id); }} type="button" role="tab"
                  id={tab.tabId} aria-controls={tab.panelId} aria-selected={selected} aria-current={selected ? "page" : undefined} tabIndex={selected ? 0 : -1}
                  onClick={() => onSelect(tab.id)}
                  onAuxClick={(event) => { if (event.button === 1 && closeOnMiddleClick) { event.preventDefault(); close(tab); } }}
                  onDoubleClick={() => { if (closeOnDoubleClick) close(tab); }}
                  onKeyDown={(event) => {
                    if (event.key === "Delete") { event.preventDefault(); close(tab); }
                    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                      event.preventDefault();
                      const step = (event.key === "ArrowLeft" ? -1 : 1) * (getComputedStyle(event.currentTarget).direction === "rtl" ? -1 : 1);
                      if (event.altKey) move(tab, tabs[index + step]); else selectAt(index + step);
                    }
                    if (event.key === "Home" || event.key === "End") { event.preventDefault(); selectAt(event.key === "Home" ? 0 : tabs.length - 1); }
                  }}
                  className="inline-flex h-8 max-w-48 items-center gap-2 rounded-md px-2.5 text-xs text-muted-foreground outline-none aria-selected:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                  {tab.icon && <span aria-hidden="true" className="inline-flex shrink-0 [&_svg]:size-3.5">{tab.icon}</span>}
                  {tab.pinned && <Pin aria-hidden="true" className="size-3 shrink-0" />}
                  <span className="truncate" title={tab.title}>{tab.title}</span>
                  {tab.dirty && <><span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" /><span className="sr-only">{labels.unsaved}</span></>}
                </button>
                {quickActions && onPinnedChange && <Button variant="ghost" size="icon" className="size-6 rounded-md" aria-label={tab.pinned ? labels.unpin(tab.title) : labels.pin(tab.title)} onClick={() => onPinnedChange(tab.id, !tab.pinned)}>{tab.pinned ? <PinOff aria-hidden="true" className="size-3" /> : <Pin aria-hidden="true" className="size-3" />}</Button>}
                {quickActions && onOpenInNewWindow && <Button variant="ghost" size="icon" className="size-6 rounded-md" aria-label={labels.openInNewWindow(tab.title)} disabled={tab.detachable === false} onClick={() => onOpenInNewWindow(tab.id)}><ExternalLink aria-hidden="true" className="size-3" /></Button>}
                {items.length > 0 && <TabActions label={labels.actions(tab.title)} items={items} restore={() => restore(tab.id)} />}
                {onClose && !tab.pinned && <Button variant="ghost" size="icon" className="mr-1 size-6 rounded-md" aria-label={labels.close(tab.title)} disabled={!canClose(tab)} onClick={() => close(tab)}><X aria-hidden="true" className="size-3.5" /></Button>}
              </div>
            </ContextMenuTrigger>
            {items.length > 0 && <ContextMenuContent ariaLabel={labels.menu(tab.title)} className="min-w-48">
              {items.map((item) => <ContextMenuItem key={item.key} disabled={item.disabled} onSelect={item.run}>{item.icon}{item.label}</ContextMenuItem>)}
            </ContextMenuContent>}
          </ContextMenu>;
        })}
      </div>
    </motion.div>
    {(onNewTab || actions) && <div data-slot="workspace-tab-actions" className="flex h-11 shrink-0 items-center gap-1 pl-1">
      {onNewTab && <Button variant="ghost" size="icon" aria-label={labels.newTab} onClick={onNewTab}><Plus className="size-4" /></Button>}{actions}
    </div>}
  </nav>;
}
