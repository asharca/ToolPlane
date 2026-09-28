"use client";

import {
  AnimatePresence,
  motion,
  useReducedMotion,
} from "motion/react";
import { type ReactNode, useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { EASE_OUT, SPRING_PANEL } from "@/lib/ease";
import { PresenceGate } from "@/lib/presence-gate";
import { cn } from "@/lib/utils";

export interface MorphingModalProps {
  /** Which view is currently shown. `null` closes the modal. */
  viewId: string | null;
  onClose: () => void;
  children: ReactNode;
  /** "bottom" anchors to the viewport bottom (mobile-like). "center" centers vertically. */
  placement?: "bottom" | "center";
  className?: string;
}

export function MorphingModal({
  viewId,
  onClose,
  children,
  placement = "bottom",
  className,
}: MorphingModalProps) {
  const open = viewId !== null;
  const reduce = useReducedMotion();
  const enterY = reduce ? 0 : placement === "bottom" ? 40 : 20;
  const enterScale = reduce ? 1 : 0.97;
  const [portalReady, setPortalReady] = useState(false);
  const [backgroundScrollLocked, setBackgroundScrollLocked] = useState(open);

  useEffect(() => setPortalReady(true), []);
  if (open && !backgroundScrollLocked) setBackgroundScrollLocked(true);

  useLayoutEffect(() => {
    if (!backgroundScrollLocked) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [backgroundScrollLocked]);

  if (!portalReady) return null;

  // Keep viewport coordinates independent of transformed/clipped consumers.
  // Motion 11 cancels WAAPI before its final inline-style write in Chrome.
  return createPortal(
    <AnimatePresence
      initial={false}
      onExitComplete={() => { if (!open) setBackgroundScrollLocked(false); }}
    >
      {open ? (
        <PresenceGate key="backdrop">
          {({ gate }) => (
            <motion.button
              type="button"
              aria-label="Close modal"
              initial={{ "--modal-opacity": 0 }}
              animate={{ "--modal-opacity": 1 }}
              exit={{ "--modal-opacity": 0 }}
              transition={{ duration: 0.2, ease: EASE_OUT }}
              {...gate}
              onClick={onClose}
              className="pointer-events-auto fixed inset-0 z-[80] bg-background/5 [backdrop-filter:blur(14px)_saturate(140%)] [-webkit-backdrop-filter:blur(14px)_saturate(140%)] [opacity:var(--modal-opacity)]"
            />
          )}
        </PresenceGate>
      ) : null}

      {open ? (
        <PresenceGate key="panel-layer">
          {({ isPresent, gate }) => (
            <motion.div
              layoutRoot
              layoutScroll
              data-framer-portal-id="morphing-modal"
              inert={!isPresent}
              className={cn(
                "pointer-events-none fixed inset-4 z-[80] flex justify-center",
                placement === "bottom" ? "items-end pb-4" : "items-center",
              )}
            >
              <motion.div
                key="panel"
                layout
                initial={{ "--modal-opacity": 0, y: enterY, scale: enterScale }}
                animate={{ "--modal-opacity": 1, y: 0, scale: 1 }}
                exit={{
                  "--modal-opacity": 0,
                  y: enterY,
                  scale: reduce ? 1 : 0.98,
                  transition: { duration: 0.18, ease: EASE_OUT },
                }}
                transition={SPRING_PANEL}
                {...gate}
                className={cn(
                  "pointer-events-auto relative w-full max-w-sm overflow-hidden rounded-3xl border border-border bg-background shadow-2xl will-change-transform [opacity:var(--modal-opacity)]",
                  className,
                )}
              >
                {/* popLayout offsets need a stable containing block during layout projection. */}
                <motion.div layout="position" className="relative p-5">
                  <AnimatePresence mode="popLayout" initial={false}>
                    <motion.div
                      key={viewId}
                      className={cn("[opacity:var(--modal-opacity)]", !reduce && "[filter:var(--modal-filter)]")}
                      initial={reduce
                        ? { "--modal-opacity": 0 }
                        : { "--modal-opacity": 0, y: 8, "--modal-filter": "blur(4px)" }}
                      animate={reduce
                        ? { "--modal-opacity": 1, transition: { duration: 0.18, ease: EASE_OUT } }
                        : { "--modal-opacity": 1, y: 0, "--modal-filter": "blur(0px)", transition: { duration: 0.24, ease: EASE_OUT } }}
                      exit={reduce
                        ? { "--modal-opacity": 0, transition: { duration: 0.14, ease: EASE_OUT } }
                        : { "--modal-opacity": 0, y: -8, "--modal-filter": "blur(4px)", transition: { duration: 0.16, ease: EASE_OUT } }}
                    >
                      {children}
                    </motion.div>
                  </AnimatePresence>
                </motion.div>
              </motion.div>
            </motion.div>
          )}
        </PresenceGate>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
