'use client';

import { DropdownMenu } from 'radix-ui';
import { MoreHorizontal, Pencil, Pin, PinOff, Trash2 } from 'lucide-react';

export function SidebarEntityActionsMenu({
  actionsLabel,
  deleteLabel,
  editLabel,
  onDelete,
  onEdit,
  onTogglePin,
  pinned,
  pinLabel,
  unpinLabel,
}: {
  actionsLabel: string;
  deleteLabel: string;
  editLabel: string;
  onDelete: () => void;
  onEdit: () => void;
  onTogglePin: () => void;
  pinned: boolean;
  pinLabel: string;
  unpinLabel: string;
}) {
  const itemClass = 'flex h-8 cursor-default select-none items-center gap-2 rounded-sm px-2 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground';

  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={actionsLabel}
          title={actionsLabel}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground"
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-50 min-w-36 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
        >
          <DropdownMenu.Item onSelect={onEdit} className={itemClass}>
            <Pencil className="size-3.5 shrink-0 text-muted-foreground" />
            {editLabel}
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={onTogglePin} className={itemClass}>
            {pinned
              ? <PinOff className="size-3.5 shrink-0 text-muted-foreground" />
              : <Pin className="size-3.5 shrink-0 text-muted-foreground" />}
            {pinned ? unpinLabel : pinLabel}
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item
            onSelect={onDelete}
            className={`${itemClass} text-destructive data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive`}
          >
            <Trash2 className="size-3.5 shrink-0" />
            {deleteLabel}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
