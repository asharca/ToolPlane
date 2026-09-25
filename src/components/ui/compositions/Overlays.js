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
import { jsx as _jsx } from "react/jsx-runtime";
import { forwardRef, } from 'react';
import { ContextMenu as ContextMenuPrimitive, HoverCard as HoverCardPrimitive, Popover as PopoverPrimitive, Tooltip as TooltipPrimitive } from '@/components/ui/primitives';
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverPortal = PopoverPrimitive.Portal;
export const PopoverClose = PopoverPrimitive.Close;
export const PopoverContent = forwardRef(function PopoverContent(_a, ref) {
    var { className, sideOffset = 4, collisionPadding = 8 } = _a, props = __rest(_a, ["className", "sideOffset", "collisionPadding"]);
    return (_jsx(PopoverPrimitive.Content, Object.assign({}, props, { ref: ref, sideOffset: sideOffset, collisionPadding: collisionPadding, "data-toolplane-ui": "popover-content", className: `z-50 max-h-[var(--radix-popover-content-available-height)] max-w-[calc(100vw-1rem)] origin-[var(--radix-popover-content-transform-origin)] overflow-auto rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 ${className !== null && className !== void 0 ? className : ''}`.trim() })));
});
export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;
export const TooltipPortal = TooltipPrimitive.Portal;
export const TooltipContent = forwardRef(function TooltipContent(_a, ref) {
    var { className, sideOffset = 6, collisionPadding = 8 } = _a, props = __rest(_a, ["className", "sideOffset", "collisionPadding"]);
    return (_jsx(TooltipPrimitive.Content, Object.assign({}, props, { ref: ref, sideOffset: sideOffset, collisionPadding: collisionPadding, "data-toolplane-ui": "tooltip-content", className: `z-50 max-w-xs origin-[var(--radix-tooltip-content-transform-origin)] rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg outline-none data-[state=closed]:animate-out data-[state=delayed-open]:animate-in data-[state=closed]:fade-out-0 data-[state=delayed-open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=delayed-open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 ${className !== null && className !== void 0 ? className : ''}`.trim() })));
});
export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
export const ContextMenuPortal = ContextMenuPrimitive.Portal;
export const ContextMenuSub = ContextMenuPrimitive.Sub;
export const ContextMenuContent = forwardRef(function ContextMenuContent(_a, ref) {
    var { className, collisionPadding = 8 } = _a, props = __rest(_a, ["className", "collisionPadding"]);
    return (_jsx(ContextMenuPrimitive.Content, Object.assign({}, props, { ref: ref, collisionPadding: collisionPadding, "data-toolplane-ui": "context-menu-content", className: `z-50 max-h-[var(--radix-context-menu-content-available-height)] min-w-40 origin-[var(--radix-context-menu-content-transform-origin)] overflow-x-hidden overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 ${className !== null && className !== void 0 ? className : ''}`.trim() })));
});
export const ContextMenuItem = forwardRef(function ContextMenuItem(_a, ref) {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (_jsx(ContextMenuPrimitive.Item, Object.assign({}, props, { ref: ref, "data-toolplane-ui": "context-menu-item", className: `relative flex min-h-8 cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground ${className !== null && className !== void 0 ? className : ''}`.trim() })));
});
export const ContextMenuSeparator = forwardRef(function ContextMenuSeparator(_a, ref) {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (_jsx(ContextMenuPrimitive.Separator, Object.assign({}, props, { ref: ref, "data-toolplane-ui": "context-menu-separator", className: `my-1 h-px bg-border ${className !== null && className !== void 0 ? className : ''}`.trim() })));
});
export const ContextMenuSubTrigger = forwardRef(function ContextMenuSubTrigger(_a, ref) {
    var { className } = _a, props = __rest(_a, ["className"]);
    return (_jsx(ContextMenuPrimitive.SubTrigger, Object.assign({}, props, { ref: ref, "data-toolplane-ui": "context-menu-sub-trigger", className: `relative flex min-h-8 cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[state=open]:bg-accent ${className !== null && className !== void 0 ? className : ''}`.trim() })));
});
export const ContextMenuSubContent = forwardRef(function ContextMenuSubContent(_a, ref) {
    var { className, collisionPadding = 8 } = _a, props = __rest(_a, ["className", "collisionPadding"]);
    return (_jsx(ContextMenuPrimitive.SubContent, Object.assign({}, props, { ref: ref, collisionPadding: collisionPadding, "data-toolplane-ui": "context-menu-sub-content", className: `z-50 min-w-40 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 ${className !== null && className !== void 0 ? className : ''}`.trim() })));
});
export const HoverCard = HoverCardPrimitive.Root;
export const HoverCardTrigger = HoverCardPrimitive.Trigger;
export const HoverCardPortal = HoverCardPrimitive.Portal;
export const HoverCardContent = forwardRef(function HoverCardContent(_a, ref) {
    var { className, sideOffset = 8, collisionPadding = 8 } = _a, props = __rest(_a, ["className", "sideOffset", "collisionPadding"]);
    return (_jsx(HoverCardPrimitive.Content, Object.assign({}, props, { ref: ref, sideOffset: sideOffset, collisionPadding: collisionPadding, "data-toolplane-ui": "hover-card-content", className: `z-50 max-w-[calc(100vw-1rem)] origin-[var(--radix-hover-card-content-transform-origin)] rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-xl outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 ${className !== null && className !== void 0 ? className : ''}`.trim() })));
});
