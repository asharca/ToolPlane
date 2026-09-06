export type SidebarGroup = {
  id: string;
  name: string;
};

export type SidebarGroupPreferences = {
  groups: SidebarGroup[];
  assignments: Record<string, string>;
  collapsed: Record<string, boolean>;
};

export const EMPTY_SIDEBAR_GROUP_PREFERENCES: SidebarGroupPreferences = {
  groups: [],
  assignments: {},
  collapsed: {},
};

function parsePreferences(value: unknown): SidebarGroupPreferences | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as {
    groups?: unknown;
    assignments?: unknown;
    collapsed?: unknown;
  };
  if (!Array.isArray(input.groups)) return null;

  const groupIds = new Set<string>();
  const groups = input.groups.flatMap((group): SidebarGroup[] => {
    if (!group || typeof group !== 'object' || Array.isArray(group)) return [];
    const { id, name } = group as { id?: unknown; name?: unknown };
    if (typeof id !== 'string' || typeof name !== 'string') return [];
    const normalizedId = id.trim().slice(0, 120);
    const normalizedName = name.trim().slice(0, 80);
    if (!normalizedId || !normalizedName || groupIds.has(normalizedId)) return [];
    groupIds.add(normalizedId);
    return [{ id: normalizedId, name: normalizedName }];
  });

  const assignments = input.assignments && typeof input.assignments === 'object' && !Array.isArray(input.assignments)
    ? Object.fromEntries(Object.entries(input.assignments).filter((entry): entry is [string, string] => (
      typeof entry[1] === 'string' && groupIds.has(entry[1])
    )))
    : {};
  const collapsed = input.collapsed && typeof input.collapsed === 'object' && !Array.isArray(input.collapsed)
    ? Object.fromEntries(Object.entries(input.collapsed).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'))
    : {};

  return { groups, assignments, collapsed };
}

export function parseSidebarGroupPreferences(value: string | null | undefined) {
  if (!value) return null;
  try {
    return parsePreferences(JSON.parse(value));
  } catch {
    return null;
  }
}

export function parseSidebarGroupPreferencesCookie(value?: string) {
  if (!value) return EMPTY_SIDEBAR_GROUP_PREFERENCES;
  try {
    return parseSidebarGroupPreferences(decodeURIComponent(value)) ?? EMPTY_SIDEBAR_GROUP_PREFERENCES;
  } catch {
    return EMPTY_SIDEBAR_GROUP_PREFERENCES;
  }
}

export function serializeSidebarGroupPreferences(value: SidebarGroupPreferences) {
  return JSON.stringify(value);
}

export function serializeSidebarGroupPreferencesCookie(value: SidebarGroupPreferences) {
  return encodeURIComponent(serializeSidebarGroupPreferences(value));
}

export function createSidebarGroupId() {
  return `group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
