import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/agents',
}));

import { getAdminPageLabelKey } from '@/components/admin/AdminSidebar';

describe('admin agent directory navigation', () => {
  it('maps the agent list and nested editor routes to the Agent directory label', () => {
    expect(getAdminPageLabelKey('/admin/agents')).toBe('adminNavAgents');
    expect(getAdminPageLabelKey('/admin/agents/listing-1/edit')).toBe('adminNavAgents');
  });
});
