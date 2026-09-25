import { type ComponentType, type ReactNode } from 'react';
type Icon = ComponentType<{
    className?: string;
}>;
export type WorkspaceTab = {
    id: string;
    icon: Icon;
    label: string;
    pinned: boolean;
};
export type WorkspaceTabBarLabels = {
    close: (label: string) => string;
    navigation: string;
    newTab: string;
    openInNewWindow: (label: string) => string;
    pin: (label: string) => string;
    unpin: (label: string) => string;
};
export declare const workspaceTabBarDefaultLabels: WorkspaceTabBarLabels;
export type WorkspaceTabBarProps = {
    actions?: ReactNode;
    activeTabId: string;
    labels?: Partial<WorkspaceTabBarLabels>;
    onClose: (id: string) => void;
    onNewTab: () => void;
    onOpenInNewWindow: (id: string) => void;
    onReorder: (sourceId: string, targetId: string) => void;
    onSelect: (id: string) => void;
    onTogglePinned: (id: string) => void;
    tabs: WorkspaceTab[];
};
export declare function WorkspaceTabBar({ actions, activeTabId, labels: labelsOverride, onClose, onNewTab, onOpenInNewWindow, onReorder, onSelect, onTogglePinned, tabs, }: WorkspaceTabBarProps): import("react").JSX.Element;
export {};
