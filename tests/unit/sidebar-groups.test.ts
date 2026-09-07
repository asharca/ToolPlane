import { describe, expect, it } from 'vitest';
import {
  EMPTY_SIDEBAR_GROUP_PREFERENCES,
  getSidebarDropEdge,
  parseSidebarGroupPreferences,
  parseSidebarGroupPreferencesCookie,
  reorderSidebarItems,
  serializeSidebarGroupPreferencesCookie,
  sortSidebarItems,
} from '@/lib/sidebar-groups';

describe('sidebar ordering preferences', () => {
  it('reads legacy preferences and round-trips the optional saved orders through cookies', () => {
    expect(parseSidebarGroupPreferences(JSON.stringify(EMPTY_SIDEBAR_GROUP_PREFERENCES)))
      .toEqual(EMPTY_SIDEBAR_GROUP_PREFERENCES);
    const preferences = {
      groups: [{ id: 'research', name: 'Research' }],
      assignments: { b: 'research' },
      collapsed: { research: false },
      entityOrder: ['b', 'a'],
      conversationOrder: { b: ['second', 'first'] },
    };
    expect(parseSidebarGroupPreferencesCookie(serializeSidebarGroupPreferencesCookie(preferences)))
      .toEqual(preferences);
  });

  it('discards malformed and duplicate order entries without losing valid groups', () => {
    expect(parseSidebarGroupPreferences(JSON.stringify({
      ...EMPTY_SIDEBAR_GROUP_PREFERENCES,
      entityOrder: ['b', 1, null, '', 'b', 'a', 'x'.repeat(121)],
      conversationOrder: { a: ['second', {}, 'second', 'first'], b: 'invalid' },
    }))).toEqual({
      ...EMPTY_SIDEBAR_GROUP_PREFERENCES,
      entityOrder: ['b', 'a'],
      conversationOrder: { a: ['second', 'first'] },
    });
    expect(parseSidebarGroupPreferences(JSON.stringify({
      ...EMPTY_SIDEBAR_GROUP_PREFERENCES, entityOrder: {}, conversationOrder: [],
    }))).toEqual(EMPTY_SIDEBAR_GROUP_PREFERENCES);
  });

  it('keeps pinned entries first and preserves default order for newly loaded items', () => {
    const items = [
      { id: 'new' }, { id: 'a' }, { id: 'pin', pinned: true }, { id: 'b' }, { id: 'newer' },
    ];
    expect(sortSidebarItems(items).map((item) => item.id)).toEqual(['pin', 'new', 'a', 'b', 'newer']);
    expect(sortSidebarItems(items, ['deleted', 'b', 'a', 'pin']).map((item) => item.id))
      .toEqual(['pin', 'b', 'a', 'new', 'newer']);
    expect(items[0].id).toBe('new');
  });

  it('inserts before or after in either direction, retaining hidden items without mutating the input', () => {
    const items = ['a', 'hidden', 'b', 'c'].map((id) => ({ id }));
    expect(reorderSidebarItems(items, 'a', 'c', 'after')).toEqual(['hidden', 'b', 'c', 'a']);
    expect(reorderSidebarItems(items, 'a', 'c', 'before')).toEqual(['hidden', 'b', 'a', 'c']);
    expect(reorderSidebarItems(items, 'c', 'a', 'before')).toEqual(['c', 'a', 'hidden', 'b']);
    expect(reorderSidebarItems(items, 'c', 'a', 'after')).toEqual(['a', 'c', 'hidden', 'b']);
    for (const [source, target] of [['a', 'a'], ['missing', 'a'], ['a', 'missing']]) {
      expect(reorderSidebarItems(items, source, target, 'after')).toEqual(['a', 'hidden', 'b', 'c']);
    }
    expect(items.map((item) => item.id)).toEqual(['a', 'hidden', 'b', 'c']);
    expect(getSidebarDropEdge(115, { top: 100, height: 32 })).toBe('before');
    expect(getSidebarDropEdge(116, { top: 100, height: 32 })).toBe('after');
  });
});
