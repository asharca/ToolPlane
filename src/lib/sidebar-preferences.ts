export function dashboardSidebarCookieName(workspaceId: string) {
  return `toolplane_dashboard_sidebar_${workspaceId}`;
}

export function assistantChatSidebarCookieName(workspaceId: string) {
  return `toolplane_assistant_chat_sidebar_${workspaceId}`;
}

export function assistantChatExpandedCookieName(workspaceId: string) {
  return `toolplane_assistant_chat_expanded_${workspaceId}`;
}

export function assistantChatGroupPreferencesCookieName(workspaceId: string) {
  return `toolplane_assistant_chat_group_preferences_${workspaceId}`;
}

export function workSidebarCookieName(workspaceId: string) {
  return `toolplane_work_sidebar_${workspaceId}`;
}

export function workAgentGroupsCookieName(workspaceId: string) {
  return `toolplane_work_agent_groups_${workspaceId}`;
}

export function workAgentGroupPreferencesCookieName(workspaceId: string) {
  return `toolplane_work_agent_group_preferences_${workspaceId}`;
}

export function serializeBooleanRecordCookie(value: Record<string, boolean>) {
  return encodeURIComponent(JSON.stringify(value));
}

export function parseBooleanRecordCookie(value?: string) {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(value));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'),
    );
  } catch {
    return {};
  }
}
