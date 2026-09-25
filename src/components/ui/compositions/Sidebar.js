// Application composition port from @asharca/ui@0.2.1 (MIT). See NOTICE.md.

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
import { jsx as _jsx } from "react/jsx-runtime";
import { forwardRef, } from 'react';
function cx(...classes) {
    return classes.filter(Boolean).join(' ');
}
export function SidebarActionRail(_a) {
    var { active = false, children, className, hasLeadingSlot = false, revealOnCellFocus = false } = _a, props = __rest(_a, ["active", "children", "className", "hasLeadingSlot", "revealOnCellFocus"]);
    return (_jsx("div", Object.assign({}, props, { "data-active": active || undefined, "data-toolplane-ui": "sidebar-action-rail", className: cx('-ml-1.5 pointer-events-none grid shrink-0 grid-cols-[0fr] opacity-0 transition-[grid-template-columns,opacity] duration-150 motion-reduce:transition-none', hasLeadingSlot ? 'mr-0' : '-mr-1', 'focus-within:pointer-events-auto focus-within:grid-cols-[1fr] focus-within:opacity-100 group-hover:pointer-events-auto group-hover:grid-cols-[1fr] group-hover:opacity-100', 'has-data-[state=open]:pointer-events-auto has-data-[state=open]:grid-cols-[1fr] has-data-[state=open]:opacity-100 group-data-[state=open]:pointer-events-auto group-data-[state=open]:grid-cols-[1fr] group-data-[state=open]:opacity-100', 'data-[active=true]:pointer-events-auto data-[active=true]:grid-cols-[1fr] data-[active=true]:opacity-100', revealOnCellFocus && 'group-has-[:focus-visible]:pointer-events-auto group-has-[:focus-visible]:grid-cols-[1fr] group-has-[:focus-visible]:opacity-100', className), children: _jsx("div", { className: "flex min-w-0 items-center overflow-hidden", children: children }) })));
}
export const SidebarActionButton = forwardRef(function SidebarActionButton(_a, ref) {
    var { className, type = 'button' } = _a, props = __rest(_a, ["className", "type"]);
    return (_jsx(BeuiButton, Object.assign({ nativeButton: true, unstyled: true }, Object.assign({}, props, { ref: ref, type: type, "data-toolplane-ui": "sidebar-action-button", className: cx('pointer-events-none flex size-5 shrink-0 items-center justify-center rounded-lg text-muted-foreground opacity-0 outline-none transition-all duration-150', 'hover:bg-accent hover:text-foreground focus-visible:pointer-events-auto focus-visible:bg-accent focus-visible:text-foreground focus-visible:opacity-100', 'group-hover:pointer-events-auto group-hover:opacity-100 group-data-[state=open]:pointer-events-auto group-data-[state=open]:opacity-100 data-[active=true]:pointer-events-auto data-[active=true]:opacity-100 data-[deleting=true]:pointer-events-auto data-[deleting=true]:opacity-100', className) }))));
});
