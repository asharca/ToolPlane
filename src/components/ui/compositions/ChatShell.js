// Application composition port from @asharca/ui@0.2.1 (MIT). See NOTICE.md.
'use client';
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useId } from 'react';
import { IconButton } from "../Controls";
export const chatShellDefaultLabels = {
    showSidebar: 'Show conversations',
    hideSidebar: 'Hide conversations',
};
export function ChatShell(_a) {
    var { sidebar, sidebarLabel, header, children, rightPanel, sidebarOpen, onSidebarOpenChange, mobilePane, onMobilePaneChange, rightPanelOpen = true, labels, className } = _a, props = __rest(_a, ["sidebar", "sidebarLabel", "header", "children", "rightPanel", "sidebarOpen", "onSidebarOpenChange", "mobilePane", "onMobilePaneChange", "rightPanelOpen", "labels", "className"]);
    const copy = Object.assign(Object.assign({}, chatShellDefaultLabels), labels);
    const showRightPanel = Boolean(rightPanel && rightPanelOpen);
    const sidebarId = useId();
    return (_jsx("div", Object.assign({}, props, { "data-chat-ui": "chat-shell", "data-mobile-pane": mobilePane, "data-right-panel-open": showRightPanel, "data-sidebar-open": sidebarOpen, className: `tp-chat-shell ${className !== null && className !== void 0 ? className : ''}`.trim(), children: _jsxs("div", { className: "tp-chat-shell__grid", children: [_jsxs("div", { id: sidebarId, className: "tp-chat-shell__sidebar", role: sidebarLabel ? 'complementary' : undefined, "aria-label": sidebarLabel, children: [_jsx("div", { className: "tp-chat-shell__sidebar-mobile-toolbar", children: _jsx(IconButton, { icon: _jsx(PanelLeftClose, { className: "tp-chat-shell__toggle-icon" }), label: copy.hideSidebar, size: "sm", variant: "ghost", "aria-controls": sidebarId, "aria-expanded": true, className: "tp-chat-shell__toggle", onClick: () => onMobilePaneChange('chat') }) }), _jsx("div", { className: "tp-chat-shell__sidebar-slot", children: sidebar })] }), _jsxs("section", { className: "tp-chat-shell__main", children: [_jsxs("div", { className: "tp-chat-shell__header", children: [_jsx(IconButton, { icon: sidebarOpen
                                        ? _jsx(PanelLeftClose, { className: "tp-chat-shell__toggle-icon" })
                                        : _jsx(PanelLeftOpen, { className: "tp-chat-shell__toggle-icon" }), label: sidebarOpen ? copy.hideSidebar : copy.showSidebar, size: "sm", variant: "ghost", "aria-controls": sidebarId, "aria-expanded": sidebarOpen, className: "tp-chat-shell__toggle tp-chat-shell__toggle--desktop", onClick: () => onSidebarOpenChange(!sidebarOpen) }), _jsx(IconButton, { icon: _jsx(PanelLeftOpen, { className: "tp-chat-shell__toggle-icon" }), label: copy.showSidebar, size: "sm", variant: "ghost", "aria-controls": sidebarId, "aria-expanded": mobilePane === 'sidebar', className: "tp-chat-shell__toggle tp-chat-shell__toggle--mobile", onClick: () => onMobilePaneChange('sidebar') }), _jsx("div", { className: "tp-chat-shell__header-slot", children: header })] }), _jsx("div", { className: "tp-chat-shell__content", children: children })] }), showRightPanel ? (_jsx("aside", { className: "tp-chat-shell__right-panel", children: rightPanel })) : null] }) })));
}
