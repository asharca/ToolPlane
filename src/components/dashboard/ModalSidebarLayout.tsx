"use client";

import { useState, type ReactNode } from "react";
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
  const active =
    sections.find((section) => section.id === activeSection) ?? sections[0];

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <DialogNav
        label={label}
        items={sections}
        active={active?.id ?? activeSection}
        onSelect={setActiveSection}
      />
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {active?.content}
      </div>
    </div>
  );
}
