export type SidebarGroup = {
  id: string;
  name: string;
};

export type SidebarGroupPreferences = {
  groups: SidebarGroup[];
  assignments: Record<string, string>;
  collapsed: Record<string, boolean>;
  entityOrder?: string[];
  conversationOrder?: Record<string, string[]>;
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
    entityOrder?: unknown;
    conversationOrder?: unknown;
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

  const entityOrder = Array.isArray(input.entityOrder) ? parseOrder(input.entityOrder) : undefined;
  const conversationOrder = input.conversationOrder && typeof input.conversationOrder === 'object' && !Array.isArray(input.conversationOrder)
    ? Object.fromEntries(Object.entries(input.conversationOrder)
      .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
      .map(([id, order]) => [id, parseOrder(order)]))
    : undefined;

  return {
    groups,
    assignments,
    collapsed,
    ...(entityOrder ? { entityOrder } : {}),
    ...(conversationOrder ? { conversationOrder } : {}),
  };
}

function parseOrder(value: unknown[]) {
  return [...new Set(value.filter((id): id is string => (
    typeof id === 'string' && id.length > 0 && id.length <= 120
  )))];
}

export type SidebarDropEdge = 'before' | 'after';

export function sortSidebarItems<T extends { id: string; pinned?: boolean }>(
  items: readonly T[],
  order: readonly string[] = [],
): T[] {
  const positions = new Map(order.map((id, index) => [id, index]));
  return [...items].sort((left, right) => (
    Number(Boolean(right.pinned)) - Number(Boolean(left.pinned))
    || (positions.get(left.id) ?? order.length) - (positions.get(right.id) ?? order.length)
  ));
}

export function reorderSidebarItems(
  items: readonly { id: string }[],
  sourceId: string,
  targetId: string,
  edge: SidebarDropEdge,
): string[] {
  const order = items.map((item) => item.id);
  if (sourceId === targetId || !order.includes(sourceId) || !order.includes(targetId)) return order;
  order.splice(order.indexOf(sourceId), 1);
  order.splice(order.indexOf(targetId) + Number(edge === 'after'), 0, sourceId);
  return order;
}

export function getSidebarDropEdge(clientY: number, rect: { top: number; height: number }): SidebarDropEdge {
  return clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}

export function sidebarDropIndicatorClassName(edge: SidebarDropEdge | undefined) {
  if (!edge) return '';
  return `before:pointer-events-none before:absolute before:inset-x-0 before:z-10 before:h-0.5 before:bg-brand before:content-[''] ${
    edge === 'before' ? 'before:top-0' : 'before:bottom-0'
  }`;
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
