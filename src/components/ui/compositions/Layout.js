// Application composition port from @asharca/ui@0.2.1 (MIT). See NOTICE.md.

import { Table as BeuiTable } from '@/components/ui/Controls';
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
function cx(...classes) {
    return classes.filter(Boolean).join(' ');
}
export function Page(_a) {
    var { as: Component = 'main', className } = _a, props = __rest(_a, ["as", "className"]);
    return (_jsx(Component, Object.assign({}, props, { "data-toolplane-ui": "page", className: cx('ui-page space-y-5', className) })));
}
export function PageHeader(_a) {
    var { actions, back, className, description, meta, title } = _a, props = __rest(_a, ["actions", "back", "className", "description", "meta", "title"]);
    return (_jsxs("header", Object.assign({}, props, { "data-toolplane-ui": "page-header", className: cx('space-y-3', className), children: [back, _jsxs("div", { className: "flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between", children: [_jsxs("div", { className: "min-w-0", children: [_jsxs("div", { className: "flex flex-wrap items-baseline gap-x-2 gap-y-1", children: [_jsx("h1", { className: "text-2xl font-bold text-foreground [text-wrap:balance]", children: title }), meta ? _jsx("span", { className: "text-sm font-medium text-muted-foreground", children: meta }) : null] }), description ? (_jsx("div", { className: "mt-1 max-w-3xl text-sm text-muted-foreground [text-wrap:pretty]", children: description })) : null] }), actions ? _jsx("div", { className: "flex shrink-0 flex-wrap items-center gap-2", children: actions }) : null] })] })));
}
export function Toolbar(_a) {
    var { actions, children, className } = _a, props = __rest(_a, ["actions", "children", "className"]);
    return (_jsxs("div", Object.assign({}, props, { "data-toolplane-ui": "toolbar", className: cx('flex flex-wrap items-center justify-between gap-3', className), children: [children ? _jsx("div", { className: "min-w-0", children: children }) : _jsx("span", {}), actions ? _jsx("div", { className: "flex flex-wrap items-center gap-2", children: actions }) : null] })));
}
export function Section(_a) {
    var { actions, children, className, count, title } = _a, props = __rest(_a, ["actions", "children", "className", "count", "title"]);
    return (_jsxs("section", Object.assign({}, props, { "data-toolplane-ui": "section", className: className, children: [_jsxs("div", { className: "mb-3 flex items-center justify-between gap-3", children: [_jsxs("h2", { className: "text-sm font-semibold text-foreground", children: [title, typeof count === 'number' ? (_jsxs("span", { className: "ml-1.5 font-normal text-muted-foreground", children: ["(", count, ")"] })) : null] }), actions ? _jsx("div", { className: "flex items-center gap-2", children: actions }) : null] }), children] })));
}
export function Panel(_a) {
    var { actions, bodyClassName, children, className, description, headerPresentation = 'muted', padded = true, title, tone = 'default' } = _a, props = __rest(_a, ["actions", "bodyClassName", "children", "className", "description", "headerPresentation", "padded", "title", "tone"]);
    const danger = tone === 'danger';
    const bordered = headerPresentation === 'bordered';
    return (_jsxs("section", Object.assign({}, props, { "data-toolplane-ui": "panel", "data-tone": tone, className: cx('ui-panel overflow-hidden', danger && 'ui-panel-danger', className), children: [_jsxs("div", { className: cx('flex items-center justify-between gap-3 px-5 py-3.5', bordered && 'min-h-14 border-b', bordered && (danger ? 'border-red-100 dark:border-red-500/20' : 'border-border'), !bordered && (danger ? 'bg-red-500/5' : 'bg-muted/25')), children: [_jsxs("div", { className: "min-w-0", children: [_jsx("h2", { className: cx('text-sm font-semibold', danger ? 'text-red-700 dark:text-red-400' : 'text-foreground'), children: title }), description ? _jsx("div", { className: "mt-0.5 text-xs text-muted-foreground", children: description }) : null] }), actions ? _jsx("div", { className: "shrink-0", children: actions }) : null] }), _jsx("div", { className: cx(padded && 'px-5 py-5', bodyClassName), children: children })] })));
}
export function EmptyState(_a) {
    var { actions, children, className, description, icon: IconComponent, title } = _a, props = __rest(_a, ["actions", "children", "className", "description", "icon", "title"]);
    return (_jsxs("div", Object.assign({}, props, { "data-toolplane-ui": "empty-state", className: cx('ui-empty', className), children: [IconComponent ? _jsx(IconComponent, { className: "mb-3 size-8 text-muted-foreground" }) : null, title ? _jsx("h2", { className: "text-lg font-semibold text-foreground", children: title }) : null, description ? (_jsx("div", { className: cx('text-sm text-muted-foreground', Boolean(title) && 'mt-1'), children: description })) : null, children ? _jsx("div", { className: "mt-6 w-full", children: children }) : null, actions ? _jsx("div", { className: "mt-5 flex flex-wrap items-center justify-center gap-2", children: actions }) : null] })));
}
export function DataTable(_a) {
    var { children, className, headers, label, minWidth = '40rem', panel = true, tableClassName } = _a, props = __rest(_a, ["children", "className", "headers", "label", "minWidth", "panel", "tableClassName"]);
    return (_jsx("div", Object.assign({}, props, { "data-toolplane-ui": "data-table", role: label ? 'region' : undefined, "aria-label": label, tabIndex: label ? 0 : undefined, className: cx(panel && 'ui-panel', 'relative overflow-x-auto overscroll-x-contain focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring', className), children: _jsxs(BeuiTable, { className: cx('ui-table', tableClassName), style: { minWidth }, children: [_jsx("thead", { children: _jsx("tr", { children: headers.map((header, index) => (_jsx("th", { scope: "col", colSpan: header.colSpan, className: cx('px-4 py-3 font-medium', header.align === 'right' && 'text-right', header.className), children: header.label }, index))) }) }), _jsx("tbody", { className: "divide-y divide-border", children: children })] }) })));
}
export function Entity(_a) {
    var { className, description, initials, mono = false, title } = _a, props = __rest(_a, ["className", "description", "initials", "mono", "title"]);
    return (_jsxs("div", Object.assign({}, props, { "data-toolplane-ui": "entity", className: cx('flex min-w-0 items-center gap-3', className), children: [initials ? (_jsx("span", { className: "grid size-8 shrink-0 place-items-center rounded-md border border-border bg-muted/45 text-[11px] font-bold text-muted-foreground", children: initials.slice(0, 2).toUpperCase() })) : null, _jsxs("span", { className: "min-w-0", children: [_jsx("span", { className: cx('block truncate font-semibold text-foreground', mono && 'font-mono text-[13px]'), children: title }), description ? _jsx("span", { className: "block truncate text-xs text-muted-foreground", children: description }) : null] })] })));
}
export function Card(_a) {
    var { className, muted = false, padded = true } = _a, props = __rest(_a, ["className", "muted", "padded"]);
    return (_jsx("div", Object.assign({}, props, { "data-toolplane-ui": "card", className: cx(muted ? 'ui-panel-muted' : 'ui-panel', padded && 'p-5', className) })));
}
