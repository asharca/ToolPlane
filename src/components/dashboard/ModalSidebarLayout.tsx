"use client";

import { useState, type ReactNode } from "react";
import { Button } from "@/components/motion/button/base";
import { ModalSidebar } from "./ModalSidebar";

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
      <ModalSidebar>
        <nav
          aria-label={label}
          className="flex gap-1 overflow-x-auto p-3 md:flex-col md:overflow-visible md:p-4"
        >
          {sections.map((section) => (
            <Button
              key={section.id}
              type="button"
              aria-current={activeSection === section.id ? "page" : undefined}
              variant={activeSection === section.id ? "secondary" : "ghost"}
              className="shrink-0 justify-start"
              onClick={() => setActiveSection(section.id)}
            >
              {section.icon}
              {section.label}
            </Button>
          ))}
        </nav>
      </ModalSidebar>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {active?.content}
      </div>
    </div>
  );
}
