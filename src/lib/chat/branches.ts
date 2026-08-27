export type ChatBranchMessage = {
  id: string;
  parentId: string | null;
  siblingGroupId?: string | null;
  role: string;
};

export type ChatBranchNavigation = {
  messageId: string;
  position: number;
  total: number;
  previousMessageId: string;
  nextMessageId: string;
};

export function chatMessagePath<T extends ChatBranchMessage>(messages: T[], activeMessageId: string | null): T[] {
  const byId = new Map(messages.map((message) => [message.id, message]));
  let current = (activeMessageId && byId.get(activeMessageId)) ?? messages.at(-1);
  const seen = new Set<string>();
  const path: T[] = [];

  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
}

export function chatBranchNavigation<T extends ChatBranchMessage>(messages: T[], path: T[]) {
  const groups = new Map<string, T[]>();
  for (const message of messages) {
    if (!message.siblingGroupId) continue;
    const key = `${message.parentId ?? 'root'}:${message.siblingGroupId}`;
    const group = groups.get(key) ?? [];
    group.push(message);
    groups.set(key, group);
  }

  return path.flatMap<ChatBranchNavigation>((message) => {
    if (!message.siblingGroupId) return [];
    const group = groups.get(`${message.parentId ?? 'root'}:${message.siblingGroupId}`) ?? [];
    if (group.length < 2) return [];
    const position = group.findIndex((item) => item.id === message.id);
    return [{
      messageId: message.id,
      position: position + 1,
      total: group.length,
      previousMessageId: group[(position - 1 + group.length) % group.length].id,
      nextMessageId: group[(position + 1) % group.length].id,
    }];
  });
}

export function latestChatBranchLeaf<T extends ChatBranchMessage>(messages: T[], throughMessageId: string) {
  const byId = new Map(messages.map((message) => [message.id, message]));
  if (!byId.has(throughMessageId)) return null;
  const order = new Map(messages.map((message, index) => [message.id, index]));

  const children = new Map<string, T[]>();
  for (const message of messages) {
    if (!message.parentId) continue;
    const group = children.get(message.parentId) ?? [];
    group.push(message);
    children.set(message.parentId, group);
  }

  let latestLeafId = throughMessageId;
  let latestLeafOrder = order.get(throughMessageId) ?? -1;
  const stack = [throughMessageId];
  while (stack.length) {
    const id = stack.pop()!;
    const descendants = children.get(id) ?? [];
    if (!descendants.length && (order.get(id) ?? -1) >= latestLeafOrder) {
      latestLeafId = id;
      latestLeafOrder = order.get(id) ?? -1;
    } else {
      stack.push(...descendants.map((message) => message.id));
    }
  }
  return latestLeafId;
}
