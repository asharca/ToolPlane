// Application composition port from @asharca/ui@0.2.1 (MIT). See NOTICE.md.
'use client';
import { Button as BeuiButton } from '@/components/ui/Controls';

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
import { Slot } from 'radix-ui';
function cx(...classes) {
    return classes.filter(Boolean).join(' ');
}
export function Chip(_a) {
    var { active = false, asChild = false, className } = _a, props = __rest(_a, ["active", "asChild", "className"]);
    const Component = asChild ? Slot.Root : 'span';
    return (_jsx(Component, Object.assign({}, props, { "data-toolplane-ui": "chip", "data-active": active || undefined, className: cx('ui-chip', active && 'ui-chip-active', className) })));
}
export function TabList(_a) {
    var { className, label, navigation = false } = _a, props = __rest(_a, ["className", "label", "navigation"]);
    const classes = cx('inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-xl bg-muted p-1 ring-1 ring-border/70', className);
    if (navigation) {
        return (_jsx("nav", Object.assign({}, props, { "aria-label": label, "data-toolplane-ui": "tab-list", className: classes })));
    }
    return (_jsx("div", Object.assign({}, props, { "data-toolplane-ui": "tab-list", role: "tablist", "aria-label": label, className: classes })));
}
export function NavigationTabs(_a) {
    var { children, className, contentClassName } = _a, props = __rest(_a, ["children", "className", "contentClassName"]);
    return (_jsx("nav", Object.assign({}, props, { "data-toolplane-ui": "navigation-tabs", className: cx('max-w-full overflow-x-auto pb-1', className), children: _jsx("div", { className: cx('inline-flex min-w-max items-center gap-1 rounded-xl bg-muted p-1 ring-1 ring-border/70', contentClassName), children: children }) })));
}
export function Breadcrumbs(_a) {
    var { 'aria-label': ariaLabel = 'Breadcrumb', children, className } = _a, props = __rest(_a, ['aria-label', "children", "className"]);
    return (_jsx("nav", Object.assign({}, props, { "aria-label": ariaLabel, "data-toolplane-ui": "breadcrumbs", className: cx('min-w-0 overflow-hidden', className), children: _jsx("ol", { className: "flex min-w-0 items-center gap-2 overflow-hidden", children: children }) })));
}
export function BreadcrumbItem(_a) {
    var { children, className, current = false, separator } = _a, props = __rest(_a, ["children", "className", "current", "separator"]);
    return (_jsxs("li", Object.assign({}, props, { className: cx('flex min-w-0 items-center gap-2', className), children: [separator ? _jsx("span", { "aria-hidden": "true", className: "shrink-0 text-muted-foreground/55", children: separator }) : null, _jsx("span", { "aria-current": current ? 'page' : undefined, className: cx('truncate', current ? 'text-muted-foreground' : 'font-semibold text-foreground'), children: children })] })));
}
export function Tab(_a) {
    var { asChild = false, children, className, count, current = false, navigation = false, type = 'button' } = _a, props = __rest(_a, ["asChild", "children", "className", "count", "current", "navigation", "type"]);
    const classes = cx('inline-flex shrink-0 items-center gap-1.5 rounded-lg px-4 py-1.5 text-sm font-medium transition-colors', current
        ? 'bg-background text-foreground shadow-sm ring-1 ring-border/60'
        : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground', className);
    if (asChild) {
        return (_jsx(Slot.Root, Object.assign({}, props, { "data-toolplane-ui": "tab", "data-current": current || undefined, role: navigation ? undefined : 'tab', "aria-current": navigation && current ? 'page' : undefined, "aria-selected": navigation ? undefined : current, className: classes, children: children })));
    }
    return (_jsxs(BeuiButton, Object.assign({ nativeButton: true, unstyled: true }, Object.assign({}, props, { type: type, "data-toolplane-ui": "tab", "data-current": current || undefined, role: navigation ? undefined : 'tab', "aria-current": navigation && current ? 'page' : undefined, "aria-selected": navigation ? undefined : current, className: classes, children: [children, typeof count === 'number' ? (_jsx("span", { className: "text-muted-foreground/70", children: count })) : null] }))));
}
export function TabPanel(_a) {
    var { className, current = false } = _a, props = __rest(_a, ["className", "current"]);
    return (_jsx("div", Object.assign({}, props, { "data-toolplane-ui": "tab-panel", role: "tabpanel", hidden: !current, className: className })));
}
export function Pagination(_a) {
    var { className, next, previous, summary } = _a, props = __rest(_a, ["className", "next", "previous", "summary"]);
    return (_jsxs("nav", Object.assign({}, props, { "data-toolplane-ui": "pagination", className: cx('flex flex-col gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between', className), children: [_jsx("span", { children: summary }), _jsxs("div", { className: "flex gap-2", children: [previous, next] })] })));
}
