"use client";

import type { ComponentType, ReactNode } from 'react';
import {
  WorkspaceTabBar as RegistryTabBar,
  type WorkspaceTabBarLabels,
} from './beui/components/workspace/workspace-tab-bar';

export type WorkspaceTab = { id: string; label: string; icon: ComponentType<{ className?: string }>; pinned: boolean };
export type { WorkspaceTabBarLabels };
export type WorkspaceTabBarProps = {
  tabs: WorkspaceTab[];
  activeTabId: string;
  labels?: Partial<WorkspaceTabBarLabels>;
  actions?: ReactNode;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNewTab: () => void;
  onOpenInNewWindow: (id: string) => void;
  onReorder: (source: string, target: string) => void;
  onTogglePinned: (id: string) => void;
};
export const workspaceTabElementId = (id: string) => `dashboard-tab-${encodeURIComponent(id)}`;

export function WorkspaceTabBar({ tabs, onTogglePinned, ...props }: WorkspaceTabBarProps) {
  return <RegistryTabBar {...props} quickActions closeOnDoubleClick
    onPinnedChange={id => onTogglePinned(id)}
    tabs={tabs.map(({ icon: Icon, label, ...tab }) => ({
      ...tab, title: label, icon: <Icon className="size-3.5" />,
      tabId: workspaceTabElementId(tab.id), panelId: 'dashboard-active-panel',
    }))} />;
}
