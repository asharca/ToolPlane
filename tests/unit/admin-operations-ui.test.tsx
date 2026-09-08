import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Link from 'next/link';
import { AdminSearchForm } from '@/components/admin/AdminUI';
import { CategoriesPanel } from '@/components/admin/CategoriesPanel';
import { SettingsChanges } from '@/components/admin/SettingsChanges';
import { adminHref, adminReturnHref } from '@/lib/admin/navigation';
import { auditWhere, logFilterSchema, logWhere } from '@/lib/observability/queries';

vi.mock('@/lib/admin/category-actions', () => ({ createCategoryAction: vi.fn(), updateCategoryAction: vi.fn(), deleteCategoryAction: vi.fn() }));

describe('practical admin navigation and forms', () => {
  it('preserves active filters in search and drops the old page', () => {
    const { container } = render(<AdminSearchForm defaultValue="writer" placeholder="Search" label="Search" searchLabel="Search" clearLabel="Clear" clearHref="/admin/agents" hidden={{ status: 'disabled' }} />);
    const data = new FormData(container.querySelector('form')!);
    expect(data.get('status')).toBe('disabled');
    expect(data.get('q')).toBe('writer');
    expect(data.has('page')).toBe(false);
  });

  it('keeps category editing and deletion in separate forms', () => {
    const { container } = render(<CategoriesPanel categories={[{ id: 'c1', name: 'Research', slug: 'research', _count: { servers: 0, skills: 0, clients: 0, agentListings: 0, assistants: 0, toolkits: 0 } }]} />);
    expect(container.querySelector('form form')).toBeNull();
    const button = screen.getByRole('button', { name: 'Delete category Research' });
    expect(button.closest('form')).toBeNull();
    fireEvent.click(button);
    expect(container.querySelector('form[aria-labelledby]')).not.toHaveAttribute('hidden');
  });

  it('retains only local admin return links', () => {
    const href = adminHref('/admin/users', { q: 'a&b', page: '2', role: 'admin', empty: '' });
    expect(adminReturnHref(href, '/admin')).toBe('/admin/users?q=a%26b&page=2&role=admin');
    for (const value of ['//evil.test/admin', 'https://evil.test/admin', '/admin/../../app', '/administrator', '/admin\\..\\app', ['x']]) {
      expect(adminReturnHref(value, '/admin')).toBe('/admin');
    }
  });

  it('uses target filters only for audit queries, not runtime events', () => {
    const filter = logFilterSchema.parse({ actorId: 'admin-1', targetType: 'user', targetId: 'user-2' });
    expect(auditWhere(filter)).toMatchObject({ actorId: 'admin-1', targetType: 'user', targetId: 'user-2' });
    expect(logWhere(filter)).not.toHaveProperty('targetId');
    expect(logWhere(filter)).not.toHaveProperty('targetType');
  });

  it('warns before leaving unsaved settings and clears after reverting', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<SettingsChanges><form><input aria-label="Limit" defaultValue="20" /></form><Link href="/admin/users">Users</Link></SettingsChanges>);
    fireEvent.input(screen.getByLabelText('Limit'), { target: { value: '30' } });
    expect(screen.getByRole('status')).toHaveTextContent('Unsaved changes');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    expect(screen.getByRole('link').dispatchEvent(click)).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    fireEvent.input(screen.getByLabelText('Limit'), { target: { value: '20' } });
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    confirm.mockRestore();
  });

  it('preserves drafts on automatic reset and while another setting is saved', () => {
    const { rerender } = render(<SettingsChanges><form key="initial"><input aria-label="Limit" defaultValue="20" /></form><form><input aria-label="Timeout" defaultValue="30" /></form></SettingsChanges>);
    const input = screen.getByLabelText('Limit') as HTMLInputElement;
    fireEvent.input(input, { target: { value: '40' } });
    fireEvent.input(screen.getByLabelText('Timeout'), { target: { value: '60' } });
    input.form!.reset();
    expect(input.value).toBe('40');
    rerender(<SettingsChanges><form key="saved"><input aria-label="Limit" defaultValue="40" /></form><form><input aria-label="Timeout" defaultValue="30" /></form></SettingsChanges>);
    expect(screen.getByLabelText('Limit')).toHaveValue('40');
    expect(screen.getByLabelText('Timeout')).toHaveValue('60');
    expect(screen.getByRole('status')).toHaveTextContent('Unsaved changes');
  });
});
