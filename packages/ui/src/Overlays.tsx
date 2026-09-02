'use client';

import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ComponentRef,
} from 'react';
import {
  ContextMenu as ContextMenuPrimitive,
  HoverCard as HoverCardPrimitive,
  Popover as PopoverPrimitive,
  Tooltip as TooltipPrimitive,
} from 'radix-ui';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverPortal = PopoverPrimitive.Portal;
export const PopoverClose = PopoverPrimitive.Close;

export const PopoverContent = forwardRef<
  ComponentRef<typeof PopoverPrimitive.Content>,
  ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(function PopoverContent({ className, sideOffset = 4, collisionPadding = 8, ...props }, ref) {
  return (
    <PopoverPrimitive.Content
      {...props}
      ref={ref}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      data-toolplane-ui="popover-content"
      className={`z-50 max-h-[var(--radix-popover-content-available-height)] max-w-[calc(100vw-1rem)] origin-[var(--radix-popover-content-transform-origin)] overflow-auto rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 ${className ?? ''}`.trim()}
    />
  );
});

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;
export const TooltipPortal = TooltipPrimitive.Portal;

export const TooltipContent = forwardRef<
  ComponentRef<typeof TooltipPrimitive.Content>,
  ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(function TooltipContent({ className, sideOffset = 6, collisionPadding = 8, ...props }, ref) {
  return (
    <TooltipPrimitive.Content
      {...props}
      ref={ref}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      data-toolplane-ui="tooltip-content"
      className={`z-50 max-w-xs origin-[var(--radix-tooltip-content-transform-origin)] rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg outline-none data-[state=closed]:animate-out data-[state=delayed-open]:animate-in data-[state=closed]:fade-out-0 data-[state=delayed-open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=delayed-open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 ${className ?? ''}`.trim()}
    />
  );
});

export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
export const ContextMenuPortal = ContextMenuPrimitive.Portal;
export const ContextMenuSub = ContextMenuPrimitive.Sub;

export const ContextMenuContent = forwardRef<
  ComponentRef<typeof ContextMenuPrimitive.Content>,
  ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(function ContextMenuContent({ className, collisionPadding = 8, ...props }, ref) {
  return (
    <ContextMenuPrimitive.Content
      {...props}
      ref={ref}
      collisionPadding={collisionPadding}
      data-toolplane-ui="context-menu-content"
      className={`z-50 max-h-[var(--radix-context-menu-content-available-height)] min-w-40 origin-[var(--radix-context-menu-content-transform-origin)] overflow-x-hidden overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 ${className ?? ''}`.trim()}
    />
  );
});

export const ContextMenuItem = forwardRef<
  ComponentRef<typeof ContextMenuPrimitive.Item>,
  ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item>
>(function ContextMenuItem({ className, ...props }, ref) {
  return (
    <ContextMenuPrimitive.Item
      {...props}
      ref={ref}
      data-toolplane-ui="context-menu-item"
      className={`relative flex min-h-8 cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground ${className ?? ''}`.trim()}
    />
  );
});

export const ContextMenuSeparator = forwardRef<
  ComponentRef<typeof ContextMenuPrimitive.Separator>,
  ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>
>(function ContextMenuSeparator({ className, ...props }, ref) {
  return (
    <ContextMenuPrimitive.Separator
      {...props}
      ref={ref}
      data-toolplane-ui="context-menu-separator"
      className={`my-1 h-px bg-border ${className ?? ''}`.trim()}
    />
  );
});

export const ContextMenuSubTrigger = forwardRef<
  ComponentRef<typeof ContextMenuPrimitive.SubTrigger>,
  ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubTrigger>
>(function ContextMenuSubTrigger({ className, ...props }, ref) {
  return (
    <ContextMenuPrimitive.SubTrigger
      {...props}
      ref={ref}
      data-toolplane-ui="context-menu-sub-trigger"
      className={`relative flex min-h-8 cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[state=open]:bg-accent ${className ?? ''}`.trim()}
    />
  );
});

export const ContextMenuSubContent = forwardRef<
  ComponentRef<typeof ContextMenuPrimitive.SubContent>,
  ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubContent>
>(function ContextMenuSubContent({ className, collisionPadding = 8, ...props }, ref) {
  return (
    <ContextMenuPrimitive.SubContent
      {...props}
      ref={ref}
      collisionPadding={collisionPadding}
      data-toolplane-ui="context-menu-sub-content"
      className={`z-50 min-w-40 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 ${className ?? ''}`.trim()}
    />
  );
});

export const HoverCard = HoverCardPrimitive.Root;
export const HoverCardTrigger = HoverCardPrimitive.Trigger;
export const HoverCardPortal = HoverCardPrimitive.Portal;

export const HoverCardContent = forwardRef<
  ComponentRef<typeof HoverCardPrimitive.Content>,
  ComponentPropsWithoutRef<typeof HoverCardPrimitive.Content>
>(function HoverCardContent({ className, sideOffset = 8, collisionPadding = 8, ...props }, ref) {
  return (
    <HoverCardPrimitive.Content
      {...props}
      ref={ref}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      data-toolplane-ui="hover-card-content"
      className={`z-50 max-w-[calc(100vw-1rem)] origin-[var(--radix-hover-card-content-transform-origin)] rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-xl outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 ${className ?? ''}`.trim()}
    />
  );
});
