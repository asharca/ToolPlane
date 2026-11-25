"use client";

import { useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { hasUnsavedWorkspaceChanges } from "@/lib/workspace/navigation";
import { ConfirmActionDialog } from "./ConversationUxPrimitives";
import { DialogNav } from "./dialog";

export type ModalSidebarSection = {
  id: string;
  label: string;
  icon?: ReactNode;
  content: ReactNode;
};

export function ModalSidebarLayout({
  label,
  sections,
  initialSection,
}: {
  label: string;
  sections: ModalSidebarSection[];
  initialSection: string;
}) {
  const [activeSection, setActiveSection] = useState(initialSection);
  const [pendingSection, setPendingSection] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const commonT = useTranslations("common");
  const workspaceT = useTranslations("console.workspaces");
  const active =
    sections.find((section) => section.id === activeSection) ?? sections[0];

  const commitSection = (nextSection: string) => {
    setActiveSection(nextSection);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("section", nextSection);
      window.history.replaceState(
        window.history.state,
        "",
        `${url.pathname}${url.search}${url.hash}`,
      );
    }
  };

  const handleSelect = (nextSection: string) => {
    if (nextSection === (active?.id ?? activeSection)) return;
    if (hasUnsavedWorkspaceChanges()) {
      setPendingSection(nextSection);
      return;
    }
    commitSection(nextSection);
  };

  return (
    <>
      <div
        ref={containerRef}
        className="flex h-full min-h-0 flex-col md:flex-row"
      >
        <DialogNav
          label={label}
          items={sections}
          active={active?.id ?? activeSection}
          onSelect={handleSelect}
        />
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {active?.content}
        </div>
      </div>
      <ConfirmActionDialog
        open={pendingSection !== null}
        title={commonT("unsavedChanges")}
        description={workspaceT("unsavedChanges")}
        confirmLabel={commonT("confirm")}
        cancelLabel={commonT("cancel")}
        destructive
        onClose={() => setPendingSection(null)}
        onConfirm={() => {
          const next = pendingSection;
          setPendingSection(null);
          if (next) commitSection(next);
        }}
      />
    </>
  );
}
