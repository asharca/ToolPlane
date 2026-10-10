"use client";
// asharca.github.io/ui/components/blocks/workspace-shell

import { motion, useReducedMotion } from "motion/react";
import { PanelLeft, X } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  AnimatedSidebar,
  AnimatedSidebarClose,
  AnimatedSidebarContent,
  AnimatedSidebarFooter,
  AnimatedSidebarGroup,
  AnimatedSidebarHeader,
  AnimatedSidebarMenu,
  AnimatedSidebarMenuButton,
  AnimatedSidebarMenuItem,
  AnimatedSidebarTrigger,
  useAnimatedSidebar,
} from "@/components/motion/animated-sidebar";
import { Tooltip } from "@/components/motion/tooltip";
import { EASE_OUT, SPRING_LAYOUT } from "@/lib/ease";
import { useHoverCapable } from "@/lib/hooks/use-hover-capable";
import { useOnOpen } from "@/lib/hooks/use-on-open";
import { cn } from "@/lib/utils";

export interface WorkspaceSidebarItem {
  id: string;
  label: string;
  icon?: ReactNode;
  badge?: ReactNode;
  href?: string;
  disabled?: boolean;
}
export interface WorkspaceSidebarGroup {
  id: string;
  title?: string;
  items: WorkspaceSidebarItem[];
}
export interface WorkspaceSidebarProps {
  groups: WorkspaceSidebarGroup[];
  activeId?: string;
  onSelect?: (id: string) => void;
  title?: string;
  /** Brand mark rendered in the header instead of the plain title text. */
  logo?: ReactNode;
  footer?: ReactNode;
  className?: string;
}

/** Composition of beUI primitives, not a second copy of the sidebar engine.
 *  The footer stays mounted and interactive while collapsed: hosts put their
 *  icon-sized workspace/avatar popovers there and manage their own visibility. */
export function WorkspaceSidebar({
  groups,
  activeId,
  onSelect,
  title = "工作区",
  logo,
  footer,
  className,
}: WorkspaceSidebarProps) {
  const { open, isMobile } = useAnimatedSidebar();
  const reduced = useReducedMotion() ?? false;
  const compact = !open && !isMobile;
  const canHover = useHoverCapable();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  useOnOpen(compact, () => setHovered(false));
  const showToggle = !compact || !logo || (canHover && hovered) || focused;
  const toggleRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (compact && document.activeElement instanceof HTMLElement) {
      const panel = toggleRef.current?.closest('[data-slot="sidebar"]');
      if (
        panel?.getAttribute("data-state") === "collapsed" &&
        panel.contains(document.activeElement)
      ) {
        const footer = panel.querySelector('[data-slot="sidebar-footer"]');
        if (
          !(
            footer instanceof HTMLElement &&
            footer.contains(document.activeElement)
          )
        )
          toggleRef.current?.focus();
      }
    }
  }, [compact]);
  // Opacity must not inherit spring velocity when hover reverses mid-flight.
  const transition = reduced
    ? { duration: 0 }
    : {
        ...SPRING_LAYOUT,
        opacity: { type: "tween" as const, duration: 0.14, ease: EASE_OUT },
      };
  return (
    <AnimatedSidebar
      ariaLabel={`${title}导航`}
      variant="inset"
      className={cn(!isMobile && "h-full", className)}
      panelClassName="static m-0 h-full rounded-none bg-transparent"
    >
      <AnimatedSidebarHeader className="px-3.5 pt-2 pb-0">
        <motion.div
          initial={false}
          animate={{ height: compact ? 36 : 64 }}
          transition={transition}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onFocusCapture={(event) =>
            setFocused(event.target.matches(":focus-visible"))
          }
          onBlurCapture={() => setFocused(false)}
          className="relative flex w-full flex-row items-center"
        >
          {isMobile ? (
            <>
              <span className="flex min-w-0 flex-1 items-center gap-2 text-xs font-semibold">
                {logo && (
                  <span className="grid size-7 shrink-0 place-items-center">
                    {logo}
                  </span>
                )}
                <span className="truncate">{title}</span>
              </span>
              <Tooltip content="关闭工作区导航">
                <AnimatedSidebarClose
                  aria-label="关闭工作区导航"
                  className="size-9 shrink-0"
                >
                  <X aria-hidden="true" className="size-4" />
                </AnimatedSidebarClose>
              </Tooltip>
            </>
          ) : (
            <>
              {logo && (
                <motion.span
                  initial={false}
                  animate={{
                    y: compact && showToggle && !reduced ? 20 : 0,
                    opacity: compact && showToggle ? 0 : 1,
                  }}
                  transition={transition}
                  aria-hidden="true"
                  className="pointer-events-none absolute left-0 grid size-9 place-items-center"
                >
                  <span className="grid size-7 place-items-center">{logo}</span>
                </motion.span>
              )}
              {/* The reveal edge and trigger share the sidebar's actual width.
                No measured-width spring chasing the sidebar's own spring. */}
              <div
                aria-hidden={compact}
                className="pointer-events-none absolute inset-y-0 left-0 right-9 overflow-hidden"
              >
                <motion.span
                  initial={false}
                  animate={{ x: compact && !reduced ? -8 : 0 }}
                  transition={transition}
                  className={cn(
                    "flex h-full items-center whitespace-nowrap text-xs font-semibold",
                    logo ? "pl-11" : "pl-2",
                  )}
                >
                  {title}
                </motion.span>
              </div>
              <Tooltip
                content={compact ? "展开工作区侧栏" : "折叠工作区侧栏"}
                side="right"
                wrapperClassName="absolute right-0 z-10"
              >
                <AnimatedSidebarTrigger
                  ref={toggleRef}
                  aria-label={compact ? "展开工作区侧栏" : "折叠工作区侧栏"}
                  className="size-9 overflow-hidden rounded-lg focus-visible:ring-inset"
                >
                  <motion.span
                    initial={false}
                    animate={{
                      x: showToggle || reduced ? 0 : 36,
                      opacity: showToggle ? 1 : 0,
                    }}
                    transition={transition}
                    className="grid size-9 shrink-0 place-items-center"
                  >
                    <PanelLeft className="size-[18px]" />
                  </motion.span>
                </AnimatedSidebarTrigger>
              </Tooltip>
            </>
          )}
        </motion.div>
      </AnimatedSidebarHeader>
      <AnimatedSidebarContent className="gap-1 px-3.5 py-2 [scrollbar-width:none]">
        {groups.map((group) => (
          <AnimatedSidebarGroup key={group.id} className="px-0 py-0">
            <AnimatedSidebarMenu className="gap-1">
              {group.items.map((item) => (
                <AnimatedSidebarMenuItem key={item.id}>
                  <AnimatedSidebarMenuButton
                    isActive={activeId === item.id}
                    onSelect={() => onSelect?.(item.id)}
                    href={item.href}
                    icon={item.icon}
                    badge={item.badge}
                    disabled={item.disabled}
                    className="min-h-9 gap-2 overflow-visible rounded-lg px-2 [&>span:first-child:not([aria-hidden])]:rounded-lg [&>span[aria-hidden=true]]:size-5 [&_svg]:size-[18px] [&>span.absolute]:bg-[var(--workspace-surface,var(--background))]"
                  >
                    {item.label}
                  </AnimatedSidebarMenuButton>
                </AnimatedSidebarMenuItem>
              ))}
            </AnimatedSidebarMenu>
          </AnimatedSidebarGroup>
        ))}
      </AnimatedSidebarContent>
      {footer && (
        <AnimatedSidebarFooter className="border-0 px-3.5 pb-3">
          {footer}
        </AnimatedSidebarFooter>
      )}
    </AnimatedSidebar>
  );
}
