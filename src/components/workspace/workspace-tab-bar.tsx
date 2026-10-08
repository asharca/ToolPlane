"use client";
// asharca.github.io/ui/components/blocks/workspace-shell

import { ArrowLeft, ArrowRight, ExternalLink, MoreHorizontal, Pin, PinOff, Plus, X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Button } from "@/components/motion/button/base";
import { MorphPopover, MorphPopoverTrigger, MorphPopoverContent } from "@/components/motion/popover-morph";
import { SPRING_LAYOUT } from "@/lib/ease";
import { cn } from "@/lib/utils";

type MenuPoint = { x: number; y: number };
const LONG_PRESS_DELAY = 520;
const LONG_PRESS_TOLERANCE = 10;

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
export interface WorkspaceTabBarProps {
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

/** Per-tab action menu. One beUI MorphPopover serves every invocation: the ⋯
 *  button, right-click, long-press and Shift+F10 all open this same panel.
 *  `openAt` positions without moving focus; a real trigger click just toggles. */
function TabActions({ title, items, restore, openRequest, onOpenHandled, anchorTabId }: {
  title: string;
  items: TabAction[];
  restore: () => void;
  openRequest: { point: MenuPoint; invocation: number } | null;
  onOpenHandled: () => void;
  anchorTabId: string;
}) {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    // beUI portals mount in an effect. Wait one frame for the actual actions.
    const frame = requestAnimationFrame(() => panel.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);
  useLayoutEffect(() => {
    if (!openRequest) return;
    anchor.current = popover.current?.querySelector<HTMLElement>(`[data-tab-menu-anchor="${anchorTabId}"]`) ?? null;
    setOpen(false);
    setOpen(true);
    onOpenHandled();
  }, [openRequest, anchorTabId, onOpenHandled]);
  return <span ref={popover} className="contents">
    <MorphPopover open={open} onOpenChange={(next) => { setOpen(next); if (!next) restore(); }}>
      {!openRequest && <MorphPopoverTrigger><Button variant="ghost" size="icon" className="size-6 rounded-md" aria-label={`${title}操作`}><MoreHorizontal className="size-3.5" /></Button></MorphPopoverTrigger>}
      <MorphPopoverContent role="menu" align="end" radius={10} className="w-48 p-1">
        <div ref={panel} inert={!open}>
          {items.map((item) => <Button key={item.key} role="menuitem" variant="ghost" size="sm" disabled={item.disabled} className="w-full justify-start rounded-md px-2 text-xs"
            onClick={() => { item.run(); setOpen(false); restore(); }}>{item.icon}{item.label}</Button>)}
        </div>
      </MorphPopoverContent>
    </MorphPopover>
  </span>;
}

/** Browser-like tabs joined to the content surface. Only the selected surface
 * moves; controls stay in place. Selection/order/dirty confirmation are host-owned.
 */
interface TabMenuHostProps {
  tab: WorkspaceTab;
  index: number;
  selected: boolean;
  items: TabAction[];
  instance: string;
  tabs: WorkspaceTab[];
  refs: React.MutableRefObject<Map<string, HTMLButtonElement>>;
  onSelect: (id: string) => void;
  close: (tab: WorkspaceTab) => void;
  closeOnMiddleClick: boolean;
  closeOnDoubleClick: boolean;
  onReorder: boolean;
  move: (tab: WorkspaceTab, target?: WorkspaceTab) => void;
  selectAt: (index: number) => void;
  restore: (id: string) => void;
  canClose: (tab: WorkspaceTab) => boolean;
  onClose: boolean;
}

/** One tab plus its sibling controls. Right-click, touch long-press and
 *  Shift+F10/CopyAll open the same MorphPopover as the ⋯ button — the
 *  ContextMenu copy is gone, so there is a single menu to maintain. */
function TabMenuHost({ tab, index, selected, items, instance, tabs, refs, onSelect, close, closeOnMiddleClick, closeOnDoubleClick, onReorder, move, selectAt, restore, canClose, onClose }: TabMenuHostProps) {
  const reduce = useReducedMotion();
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchOrigin = useRef<MenuPoint | null>(null);
  const [openRequest, setOpenRequest] = useState<{ point: MenuPoint; invocation: number } | null>(null);

  const cancelLongPress = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    touchOrigin.current = null;
  }, []);
  useEffect(() => cancelLongPress, [cancelLongPress]);

  const openMenuAt = useCallback((point: MenuPoint) => {
    setOpenRequest((current) => ({ point, invocation: (current?.invocation ?? 0) + 1 }));
  }, []);

  const onContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    if (!items.length) return;
    event.preventDefault();
    cancelLongPress();
    openMenuAt({ x: event.clientX, y: event.clientY });
  };
  // Touch/pen: hold to open, like the platform context menu. A drag cancels.
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!items.length) return;
    const pressToOpen = event.pointerType === "touch" || event.pointerType === "pen";
    if (pressToOpen) {
      const origin = { x: event.clientX, y: event.clientY };
      touchOrigin.current = origin;
      longPressTimer.current = setTimeout(() => {
        longPressTimer.current = null;
        touchOrigin.current = null;
        openMenuAt(origin);
      }, LONG_PRESS_DELAY);
    }
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const origin = touchOrigin.current;
    if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > LONG_PRESS_TOLERANCE) cancelLongPress();
  };
  // Keyboard: Menu key or Shift+F10 opens at the tab, matching ContextMenu's contract.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Delete") { event.preventDefault(); close(tab); }
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      if (!items.length) return;
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      openMenuAt({ x: rect.left + Math.min(24, rect.width / 2), y: rect.top + rect.height / 2 });
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const step = (event.key === "ArrowLeft" ? -1 : 1) * (getComputedStyle(event.currentTarget).direction === "rtl" ? -1 : 1);
      if (event.altKey) move(tab, tabs[index + step]); else selectAt(index + step);
    }
    if (event.key === "Home" || event.key === "End") { event.preventDefault(); selectAt(event.key === "Home" ? 0 : tabs.length - 1); }
  };

  return (
    /* biome-ignore lint/a11y/useSemanticElements: This groups a tab and sibling actions, not form fields. */
    <div role="group" aria-label={`${tab.title}标签及操作`} data-slot="workspace-tab" data-tab-key={tab.id} data-active={selected} tabIndex={-1}
      draggable={onReorder}
      onContextMenu={onContextMenu}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={cancelLongPress}
      onPointerCancel={cancelLongPress}
      onKeyDown={onKeyDown}
      onDragStart={(event) => { event.dataTransfer.setData("text/plain", `${instance}:${tab.id}`); event.dataTransfer.effectAllowed = "move"; }}
      onDragOver={(event) => { if (onReorder) event.preventDefault(); }}
      onDrop={(event) => { event.preventDefault(); const key = event.dataTransfer.getData("text/plain"); const source = tabs.find((item) => `${instance}:${item.id}` === key); if (source) move(source, tab); }}
      className="group relative isolate flex h-10 shrink-0 items-center rounded-t-[var(--workspace-radius,0.75rem)] px-1 pb-0.5 outline-none">
      {selected && <motion.span aria-hidden="true" data-slot="workspace-tab-selection" initial={false}
        layoutId={reduce ? undefined : `${instance}-surface`} transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
        className={cn("pointer-events-none absolute inset-0 -z-10 rounded-t-[var(--workspace-radius,0.75rem)] bg-[var(--workspace-surface,var(--background))] after:absolute after:-right-2 after:bottom-0 after:size-2 after:bg-[radial-gradient(circle_at_top_right,transparent_70%,var(--workspace-surface,var(--background))_72%)]", index > 0 && "before:absolute before:-left-2 before:bottom-0 before:size-2 before:bg-[radial-gradient(circle_at_top_left,transparent_70%,var(--workspace-surface,var(--background))_72%)]")} />}
      <button ref={(node) => { if (node) refs.current.set(tab.id, node); else refs.current.delete(tab.id); }} type="button" role="tab"
        id={tab.tabId} aria-controls={tab.panelId} aria-selected={selected} tabIndex={selected ? 0 : -1}
        onClick={() => onSelect(tab.id)}
        onAuxClick={(event) => { if (event.button === 1 && closeOnMiddleClick) { event.preventDefault(); close(tab); } }}
        onDoubleClick={() => { if (closeOnDoubleClick) close(tab); }}
        className="inline-flex h-8 max-w-48 items-center gap-2 rounded-md px-2.5 text-xs text-muted-foreground outline-none aria-selected:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        {tab.icon && <span aria-hidden="true" className="inline-flex shrink-0 [&_svg]:size-3.5">{tab.icon}</span>}
        {tab.pinned && <Pin aria-hidden="true" className="size-3 shrink-0" />}
        <span className="truncate" title={tab.title}>{tab.title}</span>
        {tab.dirty && <><span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" /><span className="sr-only">（未保存）</span></>}
      </button>
      {items.length > 0 && <TabActions title={tab.title} items={items} restore={() => restore(tab.id)} openRequest={openRequest} onOpenHandled={() => setOpenRequest(null)} anchorTabId={tab.id} />}
      {onClose && !tab.pinned && <Button variant="ghost" size="icon" className="mr-1 size-6 rounded-md" aria-label={`关闭 ${tab.title}`} disabled={!canClose(tab)} onClick={() => close(tab)}><X aria-hidden="true" className="size-3.5" /></Button>}
    </div>
  );
}

export function WorkspaceTabBar({ tabs, activeTabId, onSelect, onClose, onReorder, onPinnedChange, onOpenInNewWindow, onNewTab, actions, closeOnMiddleClick = true, closeOnDoubleClick = false, className }: WorkspaceTabBarProps) {
  const instance = useId();
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
    const target = tabs[(index + tabs.length) % tabs.length];
    if (target) { onSelect(target.id); restore(target.id); }
  };
  const menuItems = (tab: WorkspaceTab, index: number) => {
    const items: TabAction[] = [];
    if (onOpenInNewWindow) items.push({ key: "detach", label: "在独立窗口打开", icon: <ExternalLink className="size-3.5" />, disabled: tab.detachable === false, run: () => onOpenInNewWindow(tab.id) });
    if (onPinnedChange) items.push({ key: "pin", label: tab.pinned ? "取消固定" : "固定标签", icon: tab.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />, run: () => onPinnedChange(tab.id, !tab.pinned) });
    if (onReorder) {
      items.push({ key: "left", label: "向左移动", icon: <ArrowLeft className="size-3.5" />, disabled: !tabs[index - 1] || Boolean(tabs[index - 1].pinned) !== Boolean(tab.pinned), run: () => move(tab, tabs[index - 1]) });
      items.push({ key: "right", label: "向右移动", icon: <ArrowRight className="size-3.5" />, disabled: !tabs[index + 1] || Boolean(tabs[index + 1].pinned) !== Boolean(tab.pinned), run: () => move(tab, tabs[index + 1]) });
    }
    if (onClose) items.push({ key: "close", label: "关闭标签", icon: <X className="size-3.5" />, disabled: !canClose(tab), run: () => close(tab) });
    return items;
  };
  return <div data-slot="workspace-tab-strip" data-leading-active={tabs[0]?.id === currentId} className={cn("flex h-11 max-w-full min-w-0 shrink-0 items-end", className)}>
    <motion.div layoutScroll ref={scroller} data-slot="workspace-tab-bar" className="min-w-0 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {/* Each tab owns sibling action buttons; never put controls inside a tab button. */}
      <div role="tablist" aria-label="工作区标签" className="flex h-11 min-w-max items-end gap-1 pt-1">
        {tabs.map((tab, index) => {
          const selected = tab.id === currentId;
          const items = menuItems(tab, index);
          return <TabMenuHost key={tab.id} tab={tab} index={index} selected={selected} items={items} instance={instance} tabs={tabs}
            refs={refs} onSelect={onSelect} close={close} closeOnMiddleClick={closeOnMiddleClick}
            closeOnDoubleClick={closeOnDoubleClick} onReorder={Boolean(onReorder)} move={move} selectAt={selectAt}
            restore={restore} canClose={canClose} onClose={Boolean(onClose)} />;
        })}
      </div>
    </motion.div>
    {onNewTab && <div className="flex h-11 shrink-0 items-center pl-1">
      <Button variant="ghost" size="icon" aria-label="新建标签" onClick={onNewTab}><Plus className="size-4" /></Button>
    </div>}
    {actions && <div data-slot="workspace-tab-actions" className="ml-auto flex h-11 shrink-0 items-center gap-1 pl-1">
      {actions}
    </div>}
  </div>;
}
