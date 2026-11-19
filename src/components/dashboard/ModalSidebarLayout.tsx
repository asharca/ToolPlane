"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { DialogNav } from "./dialog";

export type ModalSidebarSection = {
  id: string;
  label: string;
  icon?: ReactNode;
  content: ReactNode;
};

const SelectSectionContext = createContext<((id: string) => void) | null>(null);

/** Switches the surrounding ModalSidebarLayout to another section. */
export function ModalSidebarSectionLink({
  section,
  className,
  children,
}: {
  section: string;
  className?: string;
  children: ReactNode;
}) {
  const select = useContext(SelectSectionContext);
  return (
    <button
      type="button"
      onClick={() => select?.(section)}
      className={className}
    >
      {children}
    </button>
  );
}

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
        <SelectSectionContext.Provider value={setActiveSection}>
          {active?.content}
        </SelectSectionContext.Provider>
      </div>
    </div>
  );
}
