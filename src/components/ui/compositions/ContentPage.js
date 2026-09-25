// Application composition port from @asharca/ui@0.2.1 (MIT). See NOTICE.md.
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function ContentPage({ title, children }) {
    return (_jsxs("div", { "data-toolplane-ui": "content-page", className: "mx-auto max-w-4xl px-3 py-8 sm:py-12", children: [_jsx("h1", { className: "mb-5 text-3xl font-semibold text-foreground", children: title }), _jsx("div", { className: "ui-panel space-y-5 p-5 text-sm leading-6 text-muted-foreground sm:p-7", children: children })] }));
}
