"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/motion/button/base";

export function ChannelDetailPanel({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const t = useTranslations("common");
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const trigger = document.activeElement;
    heading.current?.focus();
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected)
        trigger.focus();
    };
  }, []);
  return (
    <section
      aria-label={title}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-6 py-4">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          <ArrowLeft className="size-4" />
          {t("back")}
        </Button>
        <h2
          ref={heading}
          tabIndex={-1}
          className="min-w-0 break-words text-base font-semibold outline-none"
        >
          {title}
        </h2>
      </header>
      {children}
    </section>
  );
}

export function ChannelPanelCancel({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  const t = useTranslations("common");
  return (
    <Button
      type="button"
      variant="ghost"
      size="md"
      disabled={disabled}
      onClick={onClick}
    >
      {t("cancel")}
    </Button>
  );
}
