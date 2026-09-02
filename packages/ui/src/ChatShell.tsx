'use client';

import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useId, type HTMLAttributes, type ReactNode } from 'react';
import { IconButton } from './Controls.tsx';

export type ChatShellMobilePane = 'sidebar' | 'chat';

export type ChatShellLabels = {
  showSidebar: string;
  hideSidebar: string;
};

export const chatShellDefaultLabels: ChatShellLabels = {
  showSidebar: 'Show conversations',
  hideSidebar: 'Hide conversations',
};

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

export function ChatShell({
  sidebar,
  sidebarLabel,
  header,
  children,
  rightPanel,
  sidebarOpen,
  onSidebarOpenChange,
  mobilePane,
  onMobilePaneChange,
  rightPanelOpen = true,
  labels,
  className,
  ...props
}: ChatShellProps) {
  const copy = { ...chatShellDefaultLabels, ...labels };
  const showRightPanel = Boolean(rightPanel && rightPanelOpen);
  const sidebarId = useId();

  return (
    <div
      {...props}
      data-chat-ui="chat-shell"
      data-mobile-pane={mobilePane}
      data-right-panel-open={showRightPanel}
      data-sidebar-open={sidebarOpen}
      className={`tp-chat-shell ${className ?? ''}`.trim()}
    >
      <div className="tp-chat-shell__grid">
        <div
          id={sidebarId}
          className="tp-chat-shell__sidebar"
          role={sidebarLabel ? 'complementary' : undefined}
          aria-label={sidebarLabel}
        >
          <div className="tp-chat-shell__sidebar-mobile-toolbar">
            <IconButton
              icon={<PanelLeftClose className="tp-chat-shell__toggle-icon" />}
              label={copy.hideSidebar}
              size="sm"
              variant="ghost"
              aria-controls={sidebarId}
              aria-expanded
              className="tp-chat-shell__toggle"
              onClick={() => onMobilePaneChange('chat')}
            />
          </div>
          <div className="tp-chat-shell__sidebar-slot">{sidebar}</div>
        </div>

        <section className="tp-chat-shell__main">
          <div className="tp-chat-shell__header">
            <IconButton
              icon={sidebarOpen
                ? <PanelLeftClose className="tp-chat-shell__toggle-icon" />
                : <PanelLeftOpen className="tp-chat-shell__toggle-icon" />}
              label={sidebarOpen ? copy.hideSidebar : copy.showSidebar}
              size="sm"
              variant="ghost"
              aria-controls={sidebarId}
              aria-expanded={sidebarOpen}
              className="tp-chat-shell__toggle tp-chat-shell__toggle--desktop"
              onClick={() => onSidebarOpenChange(!sidebarOpen)}
            />
            <IconButton
              icon={<PanelLeftOpen className="tp-chat-shell__toggle-icon" />}
              label={copy.showSidebar}
              size="sm"
              variant="ghost"
              aria-controls={sidebarId}
              aria-expanded={mobilePane === 'sidebar'}
              className="tp-chat-shell__toggle tp-chat-shell__toggle--mobile"
              onClick={() => onMobilePaneChange('sidebar')}
            />
            <div className="tp-chat-shell__header-slot">{header}</div>
          </div>
          <div className="tp-chat-shell__content">{children}</div>
        </section>

        {showRightPanel ? (
          <aside className="tp-chat-shell__right-panel">{rightPanel}</aside>
        ) : null}
      </div>
    </div>
  );
}
