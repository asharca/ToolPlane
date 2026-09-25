'use client';

import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import {
  Popover as PopoverPrimitive, DropdownMenu as DropdownMenuPrimitive,
  Tooltip as TooltipPrimitive, ContextMenu as ContextMenuPrimitive,
  HoverCard as HoverCardPrimitive, Dialog as DialogPrimitive,
} from 'radix-ui';
import { cn } from './beui/lib/utils';
import { DialogContent, DialogOverlay, DialogTitle, DialogDescription } from './Dialog';

const panel = 'beui-overlay z-50 rounded-2xl border border-border bg-popover p-2 text-popover-foreground shadow-xl outline-none';
const row = 'relative flex cursor-default select-none items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50';
const PopoverContent = forwardRef<ElementRef<typeof PopoverPrimitive.Content>, ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>>(function PopoverContent({ className, sideOffset = 6, ...props }, ref) {
  return <PopoverPrimitive.Content {...props} ref={ref} sideOffset={sideOffset} data-ui-engine="beui" className={cn(panel, className)} />;
});
const DropdownContent = forwardRef<ElementRef<typeof DropdownMenuPrimitive.Content>, ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>>(function DropdownContent({ className, sideOffset = 6, ...props }, ref) {
  return <DropdownMenuPrimitive.Content {...props} ref={ref} sideOffset={sideOffset} data-ui-engine="beui" className={cn(panel, className)} />;
});
const DropdownItem = forwardRef<ElementRef<typeof DropdownMenuPrimitive.Item>, ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item>>(function DropdownItem({ className, ...props }, ref) {
  return <DropdownMenuPrimitive.Item {...props} ref={ref} className={cn(row, className)} />;
});
const TooltipContent = forwardRef<ElementRef<typeof TooltipPrimitive.Content>, ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>>(function TooltipContent({ className, sideOffset = 6, ...props }, ref) {
  return <TooltipPrimitive.Content {...props} ref={ref} sideOffset={sideOffset} data-ui-engine="beui" className={cn(panel, 'max-w-xs px-3 py-2 text-xs', className)} />;
});
const ContextContent = forwardRef<ElementRef<typeof ContextMenuPrimitive.Content>, ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>>(function ContextContent({ className, ...props }, ref) {
  return <ContextMenuPrimitive.Content {...props} ref={ref} data-ui-engine="beui" className={cn(panel, className)} />;
});
const ContextItem = forwardRef<ElementRef<typeof ContextMenuPrimitive.Item>, ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item>>(function ContextItem({ className, ...props }, ref) {
  return <ContextMenuPrimitive.Item {...props} ref={ref} className={cn(row, className)} />;
});
const HoverContent = forwardRef<ElementRef<typeof HoverCardPrimitive.Content>, ComponentPropsWithoutRef<typeof HoverCardPrimitive.Content>>(function HoverContent({ className, sideOffset = 6, ...props }, ref) {
  return <HoverCardPrimitive.Content {...props} ref={ref} sideOffset={sideOffset} data-ui-engine="beui" className={cn(panel, className)} />;
});
export const Popover = { ...PopoverPrimitive, Content: PopoverContent };
export const DropdownMenu = { ...DropdownMenuPrimitive, Content: DropdownContent, Item: DropdownItem };
export const Tooltip = { ...TooltipPrimitive, Content: TooltipContent };
export const ContextMenu = { ...ContextMenuPrimitive, Content: ContextContent, Item: ContextItem };
export const HoverCard = { ...HoverCardPrimitive, Content: HoverContent };
export const Dialog = { ...DialogPrimitive, Content: DialogContent, Overlay: DialogOverlay, Title: DialogTitle, Description: DialogDescription };
