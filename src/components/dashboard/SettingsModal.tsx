"use client";
import {
  CenterMorphModal,
  CenterMorphModalContent,
} from "@/components/motion/center-morph-modal";

import { createContext, useContext, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { hasUnsavedWorkspaceChanges } from "@/lib/workspace/navigation";
import { DialogHeader } from "./dialog";

const InterceptedSettingsContext = createContext(false);
const CloseSettingsContext = createContext<(() => void) | null>(null);

/** Closes the surrounding settings modal without the unsaved-changes prompt. */
export function useCloseSettingsModal() {
  return useContext(CloseSettingsContext);
}

export function InterceptedSettingsProvider({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <InterceptedSettingsContext.Provider value={true}>
      {children}
    </InterceptedSettingsContext.Provider>
  );
}

export function SettingsModal({
  title,
  fallbackHref,
  compact = false,
  children,
}: {
  title: string;
  fallbackHref: string;
  compact?: boolean;
  children: ReactNode;
}) {
  const router = useRouter();
  const intercepted = useContext(InterceptedSettingsContext);
  const [open, setOpen] = useState(true);
  const t = useTranslations("console.common");
  const workspaceT = useTranslations("console.workspaces");
  const returnTo = useSearchParams().get("returnTo");
  const closeHref =
    (returnTo === "/app?view=workspaces" || returnTo?.startsWith("/app/")) &&
    !returnTo.includes("/settings/account")
      ? returnTo
      : fallbackHref;
  const close = () => {
    if (
      hasUnsavedWorkspaceChanges() &&
      !window.confirm(workspaceT("unsavedChanges"))
    )
      return;
    setOpen(false);
  };

  return (
    <CenterMorphModal
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <CenterMorphModalContent
        ariaLabel={title}
        closeButtonLabel={t("close")}
        onExitComplete={() => {
          if (intercepted) router.back();
          else router.replace(closeHref);
        }}
        className={`flex flex-col overflow-hidden w-full ${compact ? "max-w-5xl h-[min(48rem,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)]" : "max-w-6xl h-[calc(100dvh-4rem)]"}`}
      >
        <DialogHeader title={title} />
        <CloseSettingsContext.Provider value={() => setOpen(false)}>
          <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
        </CloseSettingsContext.Provider>
      </CenterMorphModalContent>
    </CenterMorphModal>
  );
}
