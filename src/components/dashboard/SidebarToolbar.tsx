"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  ChevronsDownUp,
  ChevronsUpDown,
  FolderPlus,
  ListFilter,
  Plus,
  Search,
  X,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Button } from "@/components/motion/button";
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger,
} from "@/components/motion/popover-morph";
import { SPRING_SWAP } from "@/lib/ease";

type SidebarToolbarProps = {
  title: string;
  searchLabel: string;
  searchPlaceholder: string;
  search: string;
  onSearchChange: (value: string) => void;
  addLabel: string;
  onAdd: () => void;
  moreLabel: string;
  moreOpen: boolean;
  onMoreOpenChange: (open: boolean) => void;
  hasItems: boolean;
  expandLabel: string;
  collapseLabel: string;
  newGroupLabel: string;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onNewGroup: () => void;
};

const iconButtonClassName = "size-8 shrink-0 rounded-lg text-muted-foreground";
const menuButtonClassName =
  "w-full justify-start gap-2 rounded-lg px-2.5 text-left text-sm";

export function SidebarToolbar(props: SidebarToolbarProps) {
  const common = useTranslations("common");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchButton = useRef<HTMLButtonElement>(null);
  const restoreSearchFocus = useRef(false);
  const reduce = useReducedMotion();
  const expanded = searchOpen || props.search.length > 0;

  function closeSearch() {
    restoreSearchFocus.current = true;
    props.onSearchChange("");
    setSearchOpen(false);
  }

  return (
    <div className="mx-1 mb-2 flex h-8 shrink-0 items-center overflow-hidden">
      <AnimatePresence
        initial={false}
        mode="wait"
        onExitComplete={() => {
          if (restoreSearchFocus.current) {
            requestAnimationFrame(() => searchButton.current?.focus());
            restoreSearchFocus.current = false;
          }
        }}
      >
        {expanded ? (
          <motion.div
            key="search"
            initial={{ width: "50%", opacity: 0 }}
            animate={{ width: "100%", opacity: 1 }}
            exit={{ width: "50%", opacity: 0 }}
            transition={reduce ? { duration: 0 } : SPRING_SWAP}
            className="ml-auto flex h-8 min-w-0 items-center gap-2 rounded-lg border border-transparent bg-muted pl-2.5 pr-1 text-muted-foreground transition-colors focus-within:border-border focus-within:bg-background"
          >
            <Search aria-hidden="true" className="size-4 shrink-0" />
            <input
              ref={(input) => input?.focus()}
              type="search"
              aria-label={props.searchLabel}
              placeholder={props.searchPlaceholder}
              value={props.search}
              onChange={(event) => props.onSearchChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  closeSearch();
                }
              }}
              className="min-w-0 flex-1 appearance-none border-0 bg-transparent p-0 text-xs text-foreground shadow-none outline-none ring-0 placeholder:text-muted-foreground focus:outline-none focus:ring-0 focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6 shrink-0 rounded-md text-muted-foreground hover:text-foreground"
              aria-label={common("close")}
              onClick={closeSearch}
            >
              <X aria-hidden="true" className="size-3.5" />
            </Button>
          </motion.div>
        ) : (
          <motion.div
            key="toolbar"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={reduce ? { duration: 0 } : SPRING_SWAP}
            className="flex w-full min-w-0 items-center justify-between gap-1"
          >
            <span className="truncate text-xs font-medium text-muted-foreground">
              {props.title}
            </span>
            <div className="flex shrink-0 items-center gap-0.5">
              <Button
                ref={searchButton}
                type="button"
                variant="ghost"
                size="icon"
                className={iconButtonClassName}
                aria-label={props.searchLabel}
                title={props.searchLabel}
                onClick={() => setSearchOpen(true)}
              >
                <Search aria-hidden="true" className="size-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={iconButtonClassName}
                aria-label={props.addLabel}
                title={props.addLabel}
                onClick={props.onAdd}
              >
                <Plus aria-hidden="true" className="size-4" />
              </Button>
              <MorphPopover
                open={props.moreOpen}
                onOpenChange={props.onMoreOpenChange}
              >
                <MorphPopoverTrigger>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={iconButtonClassName}
                    aria-label={props.moreLabel}
                    title={props.moreLabel}
                  >
                    <ListFilter aria-hidden="true" className="size-4" />
                  </Button>
                </MorphPopoverTrigger>
                <MorphPopoverContent
                  side="bottom"
                  align="end"
                  sideOffset={4}
                  className="z-50 w-52 p-1.5"
                >
                  {props.hasItems ? (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={menuButtonClassName}
                        onClick={props.onExpandAll}
                      >
                        <ChevronsUpDown className="size-4 shrink-0" />
                        <span>{props.expandLabel}</span>
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={menuButtonClassName}
                        onClick={props.onCollapseAll}
                      >
                        <ChevronsDownUp className="size-4 shrink-0" />
                        <span>{props.collapseLabel}</span>
                      </Button>
                    </>
                  ) : null}
                  <div className="my-1 h-px bg-border" />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={menuButtonClassName}
                    onClick={props.onNewGroup}
                  >
                    <FolderPlus className="size-4 shrink-0" />
                    <span>{props.newGroupLabel}</span>
                  </Button>
                </MorphPopoverContent>
              </MorphPopover>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
