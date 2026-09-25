import { type HTMLAttributes, type ReactNode } from 'react';
export type ChatShellMobilePane = 'sidebar' | 'chat';
export type ChatShellLabels = {
    showSidebar: string;
    hideSidebar: string;
};
export declare const chatShellDefaultLabels: ChatShellLabels;
export type ChatShellProps = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
    sidebar: ReactNode;
    sidebarLabel?: string;
    header?: ReactNode;
    children: ReactNode;
    rightPanel?: ReactNode;
    sidebarOpen: boolean;
    onSidebarOpenChange: (open: boolean) => void;
    mobilePane: ChatShellMobilePane;
    onMobilePaneChange: (pane: ChatShellMobilePane) => void;
    rightPanelOpen?: boolean;
    labels?: Partial<ChatShellLabels>;
};
export declare function ChatShell({ sidebar, sidebarLabel, header, children, rightPanel, sidebarOpen, onSidebarOpenChange, mobilePane, onMobilePaneChange, rightPanelOpen, labels, className, ...props }: ChatShellProps): import("react").JSX.Element;
