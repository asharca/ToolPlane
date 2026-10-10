"use client";

import type { ComponentProps } from "react";
import { Plus } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { Button } from "@/components/motion/button";
import { SPRING_SWAP } from "@/lib/ease";
import { cn } from "@/lib/utils";

export function ComposerToolsButton({
  open,
  className,
  ...props
}: ComponentProps<typeof Button> & { open: boolean }) {
  const reduce = useReducedMotion() ?? false;

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      {...props}
      className={cn("size-8 rounded-full", className)}
    >
      <motion.span
        aria-hidden="true"
        animate={{ rotate: open ? 45 : 0 }}
        transition={reduce ? { duration: 0 } : SPRING_SWAP}
      >
        <Plus className="size-4" />
      </motion.span>
    </Button>
  );
}
