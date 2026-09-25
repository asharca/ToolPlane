import { type ReactNode } from 'react';
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
export declare const conversationSidebarDefaultLabels: ConversationSidebarLabels;
export type ConversationSidebarProps = {
    groups: ConversationSidebarGroup[];
    activeGroupId?: string | null;
    activeConversationId?: string | null;
    labels?: Partial<ConversationSidebarLabels>;
    className?: string;
    onSelectGroup?: (group: ConversationSidebarGroup) => void;
    onSelectConversation: (conversation: ConversationSidebarConversation, group: ConversationSidebarGroup) => void;
    onCreateGroup?: () => void;
    onCreateConversation?: (group: ConversationSidebarGroup) => void;
    onRenameConversation?: (conversation: ConversationSidebarConversation, group: ConversationSidebarGroup) => void;
    onDeleteConversation?: (conversation: ConversationSidebarConversation, group: ConversationSidebarGroup) => void;
};
export declare function ConversationSidebar({ groups, activeGroupId, activeConversationId, labels: labelsOverride, className, onSelectGroup, onSelectConversation, onCreateGroup, onCreateConversation, onRenameConversation, onDeleteConversation, }: ConversationSidebarProps): import("react").JSX.Element;
