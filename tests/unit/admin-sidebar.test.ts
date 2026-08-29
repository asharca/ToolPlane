import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/agents',
}));

import { getAdminPageLabelKey } from '@/components/admin/AdminSidebar';

describe('admin navigation', () => {
  it('maps the agent list and nested editor routes to the Agent directory label', () => {
    expect(getAdminPageLabelKey('/admin/agents')).toBe('adminNavAgents');
    expect(getAdminPageLabelKey('/admin/agents/listing-1/edit')).toBe('adminNavAgents');
  });
  it('maps the assistant catalog to the Assistant directory label', () => {
    expect(getAdminPageLabelKey('/admin/assistants')).toBe('adminNavAssistants');
  });
  it('maps the system settings route to the Settings label', () => {
    expect(getAdminPageLabelKey('/admin/settings')).toBe('adminNavSettings');
  });
  it('maps market review routes to the release review label', () => {
    expect(getAdminPageLabelKey('/admin/market')).toBe('adminNavMarketReviews');
  });
});
