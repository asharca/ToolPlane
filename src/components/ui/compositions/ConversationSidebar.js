// Application composition port from @asharca/ui@0.2.1 (MIT). See NOTICE.md.
'use client';
import { Button as BeuiButton } from '@/components/ui/Controls';

import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useId, useMemo, useState } from 'react';
import { Bot, ChevronRight, MessageSquare, Pencil, Plus, Trash2, } from 'lucide-react';
import { IconButton, SearchInput } from "../Controls";
import { SidebarActionRail } from "./Sidebar.js";
export const conversationSidebarDefaultLabels = {
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
function cx(...classes) {
    return classes.filter(Boolean).join(' ');
}
export function ConversationSidebar({ groups, activeGroupId, activeConversationId, labels: labelsOverride, className, onSelectGroup, onSelectConversation, onCreateGroup, onCreateConversation, onRenameConversation, onDeleteConversation, }) {
    const labels = Object.assign(Object.assign({}, conversationSidebarDefaultLabels), labelsOverride);
    const controlsId = useId();
    const [query, setQuery] = useState('');
    const [collapsedGroupIds, setCollapsedGroupIds] = useState(() => new Set());
    const needle = query.trim().toLocaleLowerCase();
    const visibleGroups = useMemo(() => groups.flatMap((group) => {
        if (!needle)
            return [{ group, conversations: group.conversations }];
        if (group.name.toLocaleLowerCase().includes(needle)) {
            return [{ group, conversations: group.conversations }];
        }
        const conversations = group.conversations.filter((conversation) => ((conversation.title || labels.untitledConversation).toLocaleLowerCase().includes(needle)));
        return conversations.length ? [{ group, conversations }] : [];
    }), [groups, labels.untitledConversation, needle]);
    function toggleGroup(groupId) {
        setCollapsedGroupIds((current) => {
            const next = new Set(current);
            if (next.has(groupId))
                next.delete(groupId);
            else
                next.add(groupId);
            return next;
        });
    }
    return (_jsxs("aside", { "aria-label": labels.groups, "data-chat-ui": "conversation-sidebar", className: cx('flex h-full min-h-0 flex-col overflow-hidden bg-background p-1.5 text-foreground', className), children: [_jsx("div", { className: "shrink-0 px-0.5", children: _jsx(SearchInput, { value: query, onChange: (event) => setQuery(event.target.value), onClear: () => setQuery(''), label: labels.searchPlaceholder, clearLabel: labels.clearSearch, placeholder: labels.searchPlaceholder, controlSize: "sm", "data-chat-ui": "sidebar-search", className: "h-7 rounded-full border-0 bg-muted/70 text-[11px] focus:ring-1 focus:ring-brand/35" }) }), _jsxs("div", { className: "mt-2 min-h-0 flex-1 overflow-y-auto", children: [_jsxs("div", { className: "flex h-8 items-center justify-between px-2.5", children: [_jsx("p", { className: "truncate text-xs font-medium text-muted-foreground", children: labels.groups }), onCreateGroup ? (_jsx(IconButton, { icon: _jsx(Plus, { className: "size-3.5" }), label: labels.newGroup, size: "sm", variant: "ghost", onClick: onCreateGroup, className: "min-h-6 w-6 shrink-0 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground" })) : null] }), _jsx("ul", { children: visibleGroups.map(({ group, conversations }, index) => {
                            const expanded = Boolean(needle) || !collapsedGroupIds.has(group.id);
                            const groupControlsId = `${controlsId}-group-${index}`;
                            const selectedGroup = group.id === activeGroupId
                                || group.conversations.some((conversation) => conversation.id === activeConversationId);
                            const groupIdentity = (_jsxs(_Fragment, { children: [_jsx("span", { className: "flex size-6 shrink-0 items-center justify-center rounded-full bg-background text-muted-foreground", children: _jsx(Bot, { className: "size-3.5" }) }), _jsx("span", { className: "min-w-0 flex-1 truncate", children: group.name })] }));
                            return (_jsxs("li", { className: "py-0.5", "data-chat-ui": "sidebar-group", children: [_jsxs("div", { className: cx('group group/sidebar-group flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-1.5 transition-colors', selectedGroup
                                            ? 'bg-muted text-foreground'
                                            : 'text-foreground/80 hover:bg-muted/60 hover:text-foreground'), children: [onSelectGroup ? (_jsxs(_Fragment, { children: [_jsx(BeuiButton, Object.assign({ nativeButton: true, unstyled: true }, { type: "button", onClick: () => onSelectGroup(group), "aria-current": group.id === activeGroupId ? 'page' : undefined, className: "flex h-8 min-w-0 flex-1 items-center gap-1.5 text-left text-[13px]", children: groupIdentity })), _jsx(IconButton, { icon: _jsx(ChevronRight, { className: cx('size-3.5 transition-transform', expanded && 'rotate-90') }), label: `${expanded ? labels.hideConversations : labels.showConversations}: ${group.name}`, size: "sm", variant: "ghost", "aria-expanded": expanded, "aria-controls": groupControlsId, onClick: () => toggleGroup(group.id), className: "-ml-1.5 hidden min-h-6 w-6 shrink-0 rounded-md text-muted-foreground group-hover:flex group-has-[:focus-visible]:flex group-has-data-[state=open]:flex hover:bg-background hover:text-foreground" })] })) : (_jsxs(BeuiButton, Object.assign({ nativeButton: true, unstyled: true }, { type: "button", "aria-expanded": expanded, "aria-controls": groupControlsId, onClick: () => toggleGroup(group.id), className: "flex h-8 min-w-0 flex-1 items-center gap-1.5 text-left text-[13px]", children: [groupIdentity, _jsx("span", { "aria-hidden": "true", className: "-ml-1.5 hidden size-6 shrink-0 items-center justify-center text-muted-foreground group-hover:flex group-has-[:focus-visible]:flex group-has-data-[state=open]:flex", children: _jsx(ChevronRight, { className: cx('size-3.5 transition-transform', expanded && 'rotate-90') }) })] }))), onCreateConversation ? (_jsx(SidebarActionRail, { hasLeadingSlot: true, revealOnCellFocus: true, children: _jsx(IconButton, { icon: _jsx(Plus, { className: "size-3.5" }), label: `${labels.newConversation}: ${group.name}`, size: "sm", variant: "ghost", onClick: () => onCreateConversation(group), title: labels.newConversation, className: "min-h-6 w-6 shrink-0 rounded-md text-muted-foreground hover:bg-background hover:text-foreground" }) })) : null] }), expanded ? (_jsx("ul", { id: groupControlsId, className: "ml-4 py-0.5 pl-1", children: conversations.length ? conversations.map((conversation) => {
                                            const title = conversation.title || labels.untitledConversation;
                                            const selected = conversation.id === activeConversationId;
                                            const hasActions = Boolean(onRenameConversation || onDeleteConversation);
                                            return (_jsx("li", { className: "relative py-0.5", "data-chat-ui": "sidebar-conversation", children: _jsxs("div", { className: cx('group group/sidebar-conversation flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-2 transition-colors', selected
                                                        ? 'bg-muted font-medium text-foreground'
                                                        : 'text-foreground/75 hover:bg-muted/60 hover:text-foreground'), children: [_jsxs(BeuiButton, Object.assign({ nativeButton: true, unstyled: true }, { type: "button", disabled: conversation.disabled, onClick: () => onSelectConversation(conversation, group), "aria-current": selected ? 'page' : undefined, title: title, className: "flex h-full min-w-0 flex-1 items-center gap-1.5 text-left text-[13px] disabled:cursor-not-allowed disabled:opacity-50", children: [_jsx(MessageSquare, { className: "size-3 shrink-0 text-muted-foreground" }), _jsx("span", { className: "min-w-0 flex-1 truncate", children: title }), conversation.meta ? (_jsx("span", { "aria-hidden": "true", className: "shrink-0", children: conversation.meta })) : null] })), hasActions ? (_jsxs(SidebarActionRail, { active: conversation.deleting, children: [onRenameConversation ? (_jsx(IconButton, { icon: _jsx(Pencil, { className: "size-3" }), label: `${labels.renameConversation}: ${title}`, size: "sm", variant: "ghost", onClick: () => onRenameConversation(conversation, group), title: labels.renameConversation, className: "min-h-6 w-6 rounded-md text-muted-foreground hover:bg-background hover:text-foreground" })) : null, onDeleteConversation ? (_jsx(IconButton, { icon: _jsx(Trash2, { className: "size-3" }), label: `${labels.deleteConversation}: ${title}`, size: "sm", variant: "ghost", loading: conversation.deleting, disabled: conversation.deleting, onClick: () => onDeleteConversation(conversation, group), title: labels.deleteConversation, className: "min-h-6 w-6 rounded-md text-muted-foreground hover:bg-background hover:text-destructive" })) : null] })) : null] }) }, conversation.id));
                                        }) : (_jsx("li", { className: "flex h-8 items-center px-2 text-xs text-muted-foreground", children: labels.noConversations })) })) : null] }, group.id));
                        }) }), !visibleGroups.length ? (_jsx("p", { className: "px-3 py-8 text-center text-xs text-muted-foreground", children: needle ? labels.noResults : labels.noGroups })) : null] })] }));
}
