"use client";

import { forwardRef, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { Input, type InputProps } from "@/components/motion/input";

export const PasswordInput = forwardRef<
  HTMLInputElement,
  Omit<InputProps, "type" | "rightIcon">
>(function PasswordInput(props, ref) {
  const [revealed, setRevealed] = useState(false);
  const t = useTranslations("console.common");
  const label = revealed ? t("hideValue") : t("showValue");

  return (
    <Input
      {...props}
      ref={ref}
      type={revealed ? "text" : "password"}
      rightIcon={
        <button
          type="button"
          aria-label={label}
          aria-pressed={revealed}
          onClick={() => setRevealed((current) => !current)}
          className="text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {revealed ? (
            <EyeOff aria-hidden="true" />
          ) : (
            <Eye aria-hidden="true" />
          )}
        </button>
      }
    />
  );
});
