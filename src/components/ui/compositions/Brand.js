// Application composition port from @asharca/ui@0.2.1 (MIT). See NOTICE.md.
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Layers3 } from 'lucide-react';
export function ToolPlaneLogo({ svgSize = 28, wordmarkClass = 'text-2xl', hideWordmarkOnMobile = false, }) {
    return (_jsxs("span", { "data-toolplane-ui": "logo", className: "inline-flex items-center gap-2", children: [_jsx("span", { "aria-hidden": "true", className: "inline-flex shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand ring-1 ring-inset ring-brand/15 transition-colors group-hover:bg-brand group-hover:text-brand-foreground", style: { width: svgSize, height: svgSize }, children: _jsx(Layers3, { size: Math.round(svgSize * 0.57), strokeWidth: 1.9 }) }), _jsxs("span", { className: `${hideWordmarkOnMobile ? 'hidden sm:inline' : 'inline'} whitespace-nowrap font-sans font-semibold text-foreground ${wordmarkClass}`, children: ["Tool", _jsx("span", { className: "font-medium text-muted-foreground", children: "Plane" })] })] }));
}
