"use client";
import { Button } from "@/components/motion/button";

import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/motion/context-menu";
import { MoreHorizontal, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import { useState } from "react";

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
  const [open, setOpen] = useState(false);
  return (
    <ContextMenu open={open} onOpenChange={setOpen}>
      <ContextMenuTrigger>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={actionsLabel}
          title={actionsLabel}
          onClick={(event) => {
            if (open) {
              setOpen(false);
              return;
            }
            const rect = event.currentTarget.getBoundingClientRect();
            event.currentTarget.dispatchEvent(
              new MouseEvent("contextmenu", {
                bubbles: true,
                clientX: rect.right,
                clientY: rect.bottom,
              }),
            );
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              event.currentTarget.click();
            }
          }}
        >
          <MoreHorizontal className="size-3.5" />
        </Button>
      </ContextMenuTrigger>
      <ContextMenuContent ariaLabel={actionsLabel}>
        <ContextMenuItem onSelect={onEdit}>
          <Pencil className="size-4" />
          {editLabel}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onTogglePin}>
          {pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
          {pinned ? unpinLabel : pinLabel}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onDelete} tone="destructive">
          <Trash2 className="size-4" />
          {deleteLabel}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
