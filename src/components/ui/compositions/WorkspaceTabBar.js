// Application composition port from @asharca/ui@0.2.1 (MIT). See NOTICE.md.
'use client';
import { Button as BeuiButton } from '@/components/ui/Controls';

import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { ExternalLink, Pin, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState, } from 'react';
export const workspaceTabBarDefaultLabels = {
    close: (label) => `Close ${label}`,
    navigation: 'Open pages',
    newTab: 'New tab',
    openInNewWindow: (label) => `Open ${label} in new window`,
    pin: (label) => `Pin ${label}`,
    unpin: (label) => `Unpin ${label}`,
};
export function WorkspaceTabBar({ actions, activeTabId, labels: labelsOverride, onClose, onNewTab, onOpenInNewWindow, onReorder, onSelect, onTogglePinned, tabs, }) {
    const labels = Object.assign(Object.assign({}, workspaceTabBarDefaultLabels), labelsOverride);
    const [draggingId, setDraggingId] = useState(null);
    const activeRef = useRef(null);
    useEffect(() => {
        var _a, _b;
        (_b = (_a = activeRef.current) === null || _a === void 0 ? void 0 : _a.scrollIntoView) === null || _b === void 0 ? void 0 : _b.call(_a, { block: 'nearest', inline: 'nearest' });
    }, [activeTabId, tabs.length]);
    return (_jsxs("nav", { "aria-label": labels.navigation, "data-toolplane-ui": "workspace-tab-bar", className: "flex h-11 shrink-0 bg-shell px-2", children: [_jsxs("ol", { className: "flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1 [&::-webkit-scrollbar]:hidden", children: [tabs.map((tab) => (_jsx(WorkspaceTabButton, { tab: tab, active: tab.id === activeTabId, canClose: tabs.length > 1, draggingId: draggingId, labels: labels, onClose: onClose, onDragChange: setDraggingId, onNewWindow: onOpenInNewWindow, onReorder: onReorder, onSelect: onSelect, onTogglePinned: onTogglePinned, activeButtonRef: tab.id === activeTabId ? activeRef : undefined }, tab.id))), _jsx("li", { className: "shrink-0", children: _jsx(BeuiButton, Object.assign({ nativeButton: true, unstyled: true }, { type: "button", "aria-label": labels.newTab, title: labels.newTab, onClick: onNewTab, className: "ui-button-ghost ui-icon-button", children: _jsx(Plus, { className: "size-4" }) })) })] }), actions] }));
}
function WorkspaceTabButton({ active, activeButtonRef, canClose, draggingId, labels, onClose, onDragChange, onNewWindow, onReorder, onSelect, onTogglePinned, tab, }) {
    const dragAllowed = Boolean(draggingId && draggingId !== tab.id);
    const controls = active || draggingId === tab.id;
    const stop = (event) => event.stopPropagation();
    const Icon = tab.icon;
    return (_jsxs("li", { "data-tab-id": tab.id, "data-active": active ? 'true' : undefined, draggable: true, onDragEnd: () => onDragChange(null), onDragStart: (event) => {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', tab.id);
            onDragChange(tab.id);
        }, onDragOver: (event) => {
            if (!dragAllowed)
                return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
        }, onDrop: (event) => {
            if (!draggingId || draggingId === tab.id)
                return;
            event.preventDefault();
            onReorder(draggingId, tab.id);
            onDragChange(null);
        }, className: `group flex h-[30px] min-w-24 max-w-56 shrink-0 items-center rounded-[10px] transition-[background-color,color,transform] duration-150 ${active ? 'bg-background text-foreground ring-1 ring-border/70' : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground'} ${draggingId === tab.id ? 'scale-[0.98] opacity-50' : ''}`, children: [_jsxs(BeuiButton, Object.assign({ nativeButton: true, unstyled: true }, { ref: activeButtonRef, type: "button", "aria-current": active ? 'page' : undefined, title: tab.label, onAuxClick: (event) => {
                    if (event.button === 1)
                        onClose(tab.id);
                }, onClick: () => onSelect(tab.id), onDoubleClick: () => onClose(tab.id), className: "flex min-w-0 flex-1 items-center gap-1.5 px-2 text-left text-xs", children: [_jsx(Icon, { className: "size-3.5 shrink-0" }), _jsx("span", { className: "truncate", children: tab.label })] })), _jsxs("div", { className: "mr-1 flex shrink-0 items-center", children: [_jsx(BeuiButton, Object.assign({ nativeButton: true, unstyled: true }, { type: "button", "aria-pressed": tab.pinned, "aria-label": tab.pinned ? labels.unpin(tab.label) : labels.pin(tab.label), title: tab.pinned ? labels.unpin(tab.label) : labels.pin(tab.label), onClick: (event) => {
                            stop(event);
                            onTogglePinned(tab.id);
                        }, className: `flex size-[18px] items-center justify-center rounded-sm transition-colors hover:bg-foreground/10 ${tab.pinned ? (controls ? 'bg-brand-soft text-accent-foreground' : 'bg-brand-soft/50 text-accent-foreground/60 group-hover:bg-brand-soft group-hover:text-accent-foreground group-focus-within:bg-brand-soft group-focus-within:text-accent-foreground') : (controls ? '' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100')}`, children: _jsx(Pin, { className: `size-3 ${tab.pinned ? 'fill-current' : ''}` }) })), _jsxs("div", { className: `flex items-center transition-opacity ${controls ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'}`, children: [_jsx(BeuiButton, Object.assign({ nativeButton: true, unstyled: true }, { type: "button", "aria-label": labels.openInNewWindow(tab.label), title: labels.openInNewWindow(tab.label), onClick: (event) => {
                                    stop(event);
                                    onNewWindow(tab.id);
                                }, className: "flex size-[18px] items-center justify-center rounded-sm hover:bg-foreground/10", children: _jsx(ExternalLink, { className: "size-3" }) })), canClose ? (_jsx(BeuiButton, Object.assign({ nativeButton: true, unstyled: true }, { type: "button", "aria-label": labels.close(tab.label), title: labels.close(tab.label), onClick: (event) => {
                                    stop(event);
                                    onClose(tab.id);
                                }, className: "flex size-[18px] items-center justify-center rounded-sm hover:bg-foreground/10", children: _jsx(X, { className: "size-3" }) }))) : null] })] })] }));
}
