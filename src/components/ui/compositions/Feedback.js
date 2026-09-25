// Application composition port from @asharca/ui@0.2.1 (MIT). See NOTICE.md.
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
import { Loader2 } from 'lucide-react';
function cx(...classes) {
    return classes.filter(Boolean).join(' ');
}
const badgeTones = {
    neutral: 'bg-muted text-muted-foreground',
    brand: 'bg-brand-soft text-accent-foreground',
    success: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
    warning: 'bg-amber-500/14 text-amber-700 dark:text-amber-300',
    danger: 'bg-red-500/12 text-red-700 dark:text-red-300',
};
export function Badge(_a) {
    var { className, tone = 'neutral' } = _a, props = __rest(_a, ["className", "tone"]);
    return (_jsx("span", Object.assign({ "data-toolplane-ui": "badge", "data-tone": tone }, props, { className: cx('inline-flex min-h-5 items-center gap-1.5 rounded px-2 py-0.5 text-[11px] font-semibold', badgeTones[tone], className) })));
}
export function StatusBadge(_a) {
    var { appearance = 'badge', className, dot = true, dotClassName, label, tone = 'neutral' } = _a, props = __rest(_a, ["appearance", "className", "dot", "dotClassName", "label", "tone"]);
    if (appearance === 'plain') {
        return (_jsxs("span", Object.assign({}, props, { "data-toolplane-ui": "status-badge", "data-tone": tone, className: cx('inline-flex items-center gap-2 text-sm text-muted-foreground', className), children: [dot ? _jsx("span", { "aria-hidden": "true", className: cx('size-2 rounded-full bg-current', dotClassName) }) : null, label] })));
    }
    return (_jsxs(Badge, Object.assign({}, props, { tone: tone, className: className, "data-toolplane-ui": "status-badge", children: [dot ? _jsx("span", { "aria-hidden": "true", className: cx('size-1.5 rounded-full bg-current', dotClassName) }) : null, label] })));
}
const alertTones = {
    info: 'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200',
    warning: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200',
    danger: 'border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200',
};
export function Alert(_a) {
    var { className, role, tone = 'info' } = _a, props = __rest(_a, ["className", "role", "tone"]);
    return (_jsx("div", Object.assign({}, props, { "data-toolplane-ui": "alert", "data-tone": tone, role: role !== null && role !== void 0 ? role : (tone === 'danger' ? 'alert' : 'status'), className: cx('rounded-md border px-4 py-3 text-sm', alertTones[tone], className) })));
}
export function Spinner(_a) {
    var { className, label } = _a, props = __rest(_a, ["className", "label"]);
    return (_jsxs("span", Object.assign({}, props, { "data-toolplane-ui": "spinner", role: label ? 'status' : undefined, "aria-hidden": label ? undefined : true, className: cx('inline-flex items-center gap-2', className), children: [_jsx(Loader2, { "aria-hidden": "true", className: "size-4 animate-spin" }), label ? _jsx("span", { className: "sr-only", children: label }) : null] })));
}
