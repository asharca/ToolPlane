'use client';

import { useId, useMemo, useState, type ReactNode } from 'react';
import {
  Bot,
  ChevronRight,
  MessageSquare,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { IconButton, SearchInput } from './Controls.tsx';
import { SidebarActionRail } from './Sidebar.tsx';

export type ConversationSidebarConversation = {
  id: string;
  title?: string | null;
  meta?: ReactNode;
  disabled?: boolean;
  deleting?: boolean;
};

export type ConversationSidebarGroup = {
  id: string;
  name: string;
  conversations: ConversationSidebarConversation[];
};

export type ConversationSidebarLabels = {
  groups: string;
  searchPlaceholder: string;
  clearSearch: string;
  newGroup: string;
  newConversation: string;
  untitledConversation: string;
  noGroups: string;
  noConversations: string;
  noResults: string;
  renameConversation: string;
  deleteConversation: string;
  showConversations: string;
  hideConversations: string;
};

export const conversationSidebarDefaultLabels: ConversationSidebarLabels = {
  groups: 'Assistants',
  searchPlaceholder: 'Search assistants and conversations',
  clearSearch: 'Clear search',
  newGroup: 'New assistant',
  newConversation: 'New conversation',
  untitledConversation: 'New conversation',
  noGroups: 'No assistants yet.',
  noConversations: 'No conversations yet.',
  noResults: 'No matching assistants or conversations.',
  renameConversation: 'Rename conversation',
  deleteConversation: 'Delete conversation',
  showConversations: 'Show conversations',
  hideConversations: 'Hide conversations',
};

export type ConversationSidebarProps = {
  groups: ConversationSidebarGroup[];
  activeGroupId?: string | null;
  activeConversationId?: string | null;
  labels?: Partial<ConversationSidebarLabels>;
  className?: string;
  onSelectGroup?: (group: ConversationSidebarGroup) => void;
  onSelectConversation: (
    conversation: ConversationSidebarConversation,
    group: ConversationSidebarGroup,
  ) => void;
  onCreateGroup?: () => void;
  onCreateConversation?: (group: ConversationSidebarGroup) => void;
  onRenameConversation?: (
    conversation: ConversationSidebarConversation,
    group: ConversationSidebarGroup,
  ) => void;
  onDeleteConversation?: (
    conversation: ConversationSidebarConversation,
    group: ConversationSidebarGroup,
  ) => void;
};

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

export function ConversationSidebar({
  groups,
  activeGroupId,
  activeConversationId,
  labels: labelsOverride,
  className,
  onSelectGroup,
  onSelectConversation,
  onCreateGroup,
  onCreateConversation,
  onRenameConversation,
  onDeleteConversation,
}: ConversationSidebarProps) {
  const labels = { ...conversationSidebarDefaultLabels, ...labelsOverride };
  const controlsId = useId();
  const [query, setQuery] = useState('');
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(() => new Set());
  const needle = query.trim().toLocaleLowerCase();
  const visibleGroups = useMemo(() => groups.flatMap((group) => {
    if (!needle) return [{ group, conversations: group.conversations }];
    if (group.name.toLocaleLowerCase().includes(needle)) {
      return [{ group, conversations: group.conversations }];
    }
    const conversations = group.conversations.filter((conversation) => (
      (conversation.title || labels.untitledConversation).toLocaleLowerCase().includes(needle)
    ));
    return conversations.length ? [{ group, conversations }] : [];
  }), [groups, labels.untitledConversation, needle]);

  function toggleGroup(groupId: string) {
    setCollapsedGroupIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  return (
    <aside
      aria-label={labels.groups}
      data-chat-ui="conversation-sidebar"
      className={cx(
        'flex h-full min-h-0 flex-col overflow-hidden bg-background p-1.5 text-foreground',
        className,
      )}
    >
      <div className="shrink-0 px-0.5">
        <SearchInput
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onClear={() => setQuery('')}
          label={labels.searchPlaceholder}
          clearLabel={labels.clearSearch}
          placeholder={labels.searchPlaceholder}
          controlSize="sm"
          data-chat-ui="sidebar-search"
          className="h-7 rounded-full border-0 bg-muted/70 text-[11px] focus:ring-1 focus:ring-brand/35"
        />
      </div>

      <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
        <div className="flex h-8 items-center justify-between px-2.5">
          <p className="truncate text-xs font-medium text-muted-foreground">{labels.groups}</p>
          {onCreateGroup ? (
            <IconButton
              icon={<Plus className="size-3.5" />}
              label={labels.newGroup}
              size="sm"
              variant="ghost"
              onClick={onCreateGroup}
              className="min-h-6 w-6 shrink-0 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            />
          ) : null}
        </div>

        <ul>
          {visibleGroups.map(({ group, conversations }, index) => {
            const expanded = Boolean(needle) || !collapsedGroupIds.has(group.id);
            const groupControlsId = `${controlsId}-group-${index}`;
            const selectedGroup = group.id === activeGroupId
              || group.conversations.some((conversation) => conversation.id === activeConversationId);
            const groupIdentity = (
              <>
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-background text-muted-foreground">
                  <Bot className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1 truncate">{group.name}</span>
              </>
            );

            return (
              <li key={group.id} className="py-0.5" data-chat-ui="sidebar-group">
                <div className={cx(
                  'group group/sidebar-group flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-1.5 transition-colors',
                  selectedGroup
                    ? 'bg-muted text-foreground'
                    : 'text-foreground/80 hover:bg-muted/60 hover:text-foreground',
                )}>
                  {onSelectGroup ? (
                    <>
                      <button
                        type="button"
                        onClick={() => onSelectGroup(group)}
                        aria-current={group.id === activeGroupId ? 'page' : undefined}
                        className="flex h-8 min-w-0 flex-1 items-center gap-1.5 text-left text-[13px]"
                      >
                        {groupIdentity}
                      </button>
                      <IconButton
                        icon={<ChevronRight className={cx('size-3.5 transition-transform', expanded && 'rotate-90')} />}
                        label={`${expanded ? labels.hideConversations : labels.showConversations}: ${group.name}`}
                        size="sm"
                        variant="ghost"
                        aria-expanded={expanded}
                        aria-controls={groupControlsId}
                        onClick={() => toggleGroup(group.id)}
                        className="-ml-1.5 hidden min-h-6 w-6 shrink-0 rounded-md text-muted-foreground group-hover:flex group-has-[:focus-visible]:flex group-has-data-[state=open]:flex hover:bg-background hover:text-foreground"
                      />
                    </>
                  ) : (
                    <button
                      type="button"
                      aria-expanded={expanded}
                      aria-controls={groupControlsId}
                      onClick={() => toggleGroup(group.id)}
                      className="flex h-8 min-w-0 flex-1 items-center gap-1.5 text-left text-[13px]"
                    >
                      {groupIdentity}
                      <span aria-hidden="true" className="-ml-1.5 hidden size-6 shrink-0 items-center justify-center text-muted-foreground group-hover:flex group-has-[:focus-visible]:flex group-has-data-[state=open]:flex">
                        <ChevronRight className={cx('size-3.5 transition-transform', expanded && 'rotate-90')} />
                      </span>
                    </button>
                  )}
                  {onCreateConversation ? (
                    <SidebarActionRail hasLeadingSlot revealOnCellFocus>
                      <IconButton
                        icon={<Plus className="size-3.5" />}
                        label={`${labels.newConversation}: ${group.name}`}
                        size="sm"
                        variant="ghost"
                        onClick={() => onCreateConversation(group)}
                        title={labels.newConversation}
                        className="min-h-6 w-6 shrink-0 rounded-md text-muted-foreground hover:bg-background hover:text-foreground"
                      />
                    </SidebarActionRail>
                  ) : null}
                </div>

                {expanded ? (
                  <ul id={groupControlsId} className="ml-4 py-0.5 pl-1">
                    {conversations.length ? conversations.map((conversation) => {
                      const title = conversation.title || labels.untitledConversation;
                      const selected = conversation.id === activeConversationId;
                      const hasActions = Boolean(onRenameConversation || onDeleteConversation);
                      return (
                        <li
                          key={conversation.id}
                          className="relative py-0.5"
                          data-chat-ui="sidebar-conversation"
                        >
                          <div className={cx(
                            'group group/sidebar-conversation flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-2 transition-colors',
                            selected
                              ? 'bg-muted font-medium text-foreground'
                              : 'text-foreground/75 hover:bg-muted/60 hover:text-foreground',
                          )}>
                            <button
                              type="button"
                              disabled={conversation.disabled}
                              onClick={() => onSelectConversation(conversation, group)}
                              aria-current={selected ? 'page' : undefined}
                              title={title}
                              className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left text-[13px] disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              <MessageSquare className="size-3 shrink-0 text-muted-foreground" />
                              <span className="min-w-0 flex-1 truncate">{title}</span>
                              {conversation.meta ? (
                                <span aria-hidden="true" className="shrink-0">
                                  {conversation.meta}
                                </span>
                              ) : null}
                            </button>
                            {hasActions ? (
                              <SidebarActionRail active={conversation.deleting}>
                                {onRenameConversation ? (
                                  <IconButton
                                    icon={<Pencil className="size-3" />}
                                    label={`${labels.renameConversation}: ${title}`}
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => onRenameConversation(conversation, group)}
                                    title={labels.renameConversation}
                                    className="min-h-6 w-6 rounded-md text-muted-foreground hover:bg-background hover:text-foreground"
                                  />
                                ) : null}
                                {onDeleteConversation ? (
                                  <IconButton
                                    icon={<Trash2 className="size-3" />}
                                    label={`${labels.deleteConversation}: ${title}`}
                                    size="sm"
                                    variant="ghost"
                                    loading={conversation.deleting}
                                    disabled={conversation.deleting}
                                    onClick={() => onDeleteConversation(conversation, group)}
                                    title={labels.deleteConversation}
                                    className="min-h-6 w-6 rounded-md text-muted-foreground hover:bg-background hover:text-destructive"
                                  />
                                ) : null}
                              </SidebarActionRail>
                            ) : null}
                          </div>
                        </li>
                      );
                    }) : (
                      <li className="flex h-8 items-center px-2 text-xs text-muted-foreground">
                        {labels.noConversations}
                      </li>
                    )}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>

        {!visibleGroups.length ? (
          <p className="px-3 py-8 text-center text-xs text-muted-foreground">
            {needle ? labels.noResults : labels.noGroups}
          </p>
        ) : null}
      </div>
    </aside>
  );
}
