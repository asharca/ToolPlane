import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import messages from '../../messages/en.json';
import { LogFilters } from '@/components/admin/LogFilters';
import { LogTimestamp } from '@/components/admin/LogUI';
import { logFilterSchema } from '@/lib/observability/queries';
import AdminLogsPage from '@/app/admin/logs/page';
import type * as LogEventModule from '@/lib/observability/events';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(), authorizeLogs: vi.fn(), listLogEvents: vi.fn(), aggregateLogs: vi.fn(),
  workspaces: vi.fn(), users: vi.fn(), audits: vi.fn(), auditCount: vi.fn(),
}));

vi.mock('@/lib/auth/admin', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('@/lib/db', () => ({ db: { user: { findMany: mocks.users }, workspace: { findMany: mocks.workspaces }, auditEvent: { findMany: mocks.audits, count: mocks.auditCount } } }));
vi.mock('@/lib/observability/queries', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/observability/queries')>(),
  authorizeLogs: mocks.authorizeLogs, listLogEvents: mocks.listLogEvents, aggregateLogs: mocks.aggregateLogs,
  getErrorGroups: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/lib/observability/events', async original => ({ ...await original<typeof LogEventModule>(), logHealth: { failures: 0, dropped: 0 } }));
vi.mock('@/lib/observability/settings', () => ({ getLogSettings: vi.fn().mockResolvedValue({ eventDays: 30, detailDays: 7, auditDays: 180, captures: [] }) }));
vi.mock('@/lib/admin/log-actions', () => ({ updateLogSettings: vi.fn() }));
vi.mock('@/components/admin/LogHealth', () => ({ LogHealth: () => null }));
vi.mock('next-intl/server', () => ({
  getLocale: async () => 'en',
  getTranslations: async () => createTranslator({ locale: 'en', namespace: 'admin', messages }),
}));

const until = new Date('2026-09-07T09:30:15.789Z');
const filters = logFilterSchema.parse({ until, since: new Date(until.getTime() - 86_400_000) });

describe('admin log presentation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ id: 'admin-1' });
    mocks.authorizeLogs.mockResolvedValue(undefined);
    mocks.aggregateLogs.mockResolvedValue({ total: 65, errors: 13, avgMs: 52, p95Ms: 80 });
    mocks.workspaces.mockResolvedValue([{ id: 'workspace-1', name: 'Engineering' }]);
    mocks.users.mockResolvedValue([]);
    mocks.listLogEvents.mockResolvedValue({ rows: [{
      id: 'event-1', createdAt: until, workspaceId: 'workspace-1', domain: 'http', outcome: 'error', level: 'info',
      httpStatus: 502, message: 'Upstream unavailable', eventName: 'http.request', durationMs: 80, detailState: 'unavailable',
    }], nextCursor: 'next-page' });
  });

  it('keeps millisecond UTC values and active resource filters in the GET form', () => {
    const { container } = render(<LogFilters tab="http" raw={{ workspaceId: 'workspace-1' }} filters={filters} observedAt={until.getTime()} />);
    expect(screen.getByLabelText('Workspace ID')).toHaveValue('workspace-1');
    const data = new FormData(container.querySelector('form')!);
    expect(data.get('since')).toBe('2026-09-06T09:30:15.789');
    expect(data.get('until')).toBe('2026-09-07T09:30:15.789');
    expect(data.get('workspaceId')).toBe('workspace-1');
  });

  it('preserves filters, but not the cursor, in time presets', () => {
    render(<LogFilters tab="http" raw={{ q: 'upstream', domain: 'mcp', cursor: 'old-page' }} filters={filters} observedAt={until.getTime()} />);
    const url = new URL(screen.getByRole('link', { name: 'Last hour' }).getAttribute('href')!, 'http://localhost');
    expect(url.searchParams.get('q')).toBe('upstream');
    expect(url.searchParams.get('domain')).toBe('mcp');
    expect(url.searchParams.has('cursor')).toBe(false);
    expect(url.searchParams.get('since')).toBe('2026-09-07T08:30:15.789Z');
    expect(url.searchParams.get('until')).toBe(until.toISOString());
  });

  it('only offers supported audit filters', () => {
    const { container } = render(<LogFilters tab="audit" raw={{ actorId: 'admin-1' }} filters={filters} observedAt={until.getTime()} />);
    expect(screen.getByLabelText('Actor ID')).toHaveValue('admin-1');
    expect(screen.getByLabelText('Trace ID')).toBeInTheDocument();
    for (const name of ['domain', 'level', 'outcome', 'agentId', 'errorType']) expect(container.querySelector(`[name=${name}]`)).toBeNull();
  });

  it('retains the exact timestamp', () => {
    const { container } = render(<LogTimestamp date={until} />);
    expect(container.querySelector('time')).toHaveAttribute('datetime', until.toISOString());
  });

  it('shows whole-window metrics alongside named resources and the current page count', async () => {
    render(await AdminLogsPage({ searchParams: Promise.resolve({ workspaceId: 'workspace-1', outcome: 'error' }) }));
    expect(screen.getByText('20.0%')).toBeInTheDocument();
    expect(await screen.findByText('Engineering')).toBeInTheDocument();
    expect(mocks.aggregateLogs).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'workspace-1', outcome: 'error' }));
    expect(screen.getByRole('link', { name: 'Older events' })).toHaveAttribute('href', expect.stringContaining('cursor=next-page'));
  });

  it('forces A2A in the form and resets pagination while retaining task filters in time presets', () => {
    const raw = { domain: 'mcp', taskId: 'task-1', direction: 'inbound', cursor: 'old-page' };
    const { container } = render(<LogFilters tab="a2a" raw={raw} filters={filters} observedAt={until.getTime()} />);
    const data = new FormData(container.querySelector('form')!);
    expect(data.getAll('domain')).toEqual(['a2a']);
    expect(data.get('taskId')).toBe('task-1');
    expect(data.has('cursor')).toBe(false);
    const url = new URL(screen.getByRole('link', { name: 'Last hour' }).getAttribute('href')!, 'http://localhost');
    expect(url.searchParams.get('domain')).toBe('a2a');
    expect(url.searchParams.get('taskId')).toBe('task-1');
    expect(url.searchParams.get('direction')).toBe('inbound');
    expect(url.searchParams.has('cursor')).toBe(false);
  });

  it('shows trusted detail availability without rendering message or attributes and preserves task pagination', async () => {
    mocks.listLogEvents.mockResolvedValue({ rows: [{
      id: 'a2a-event', createdAt: until, domain: 'a2a', outcome: 'error', level: 'info',
      eventName: 'a2a.request', rpcMethod: 'GetTask', message: 'private business text',
      attributes: { data: { a2a: { direction: 'inbound', transport: 'jsonrpc', clientId: 'client-1' }, private: 'private attribute text' } },
      httpStatus: 200, durationMs: 12, detailState: 'expired',
    }], nextCursor: 'next-page' });
    const { container } = render(await AdminLogsPage({ searchParams: Promise.resolve({ tab: 'a2a', domain: 'mcp', taskId: 'task-1', direction: 'inbound', since: filters.since.toISOString(), until: until.toISOString() }) }));
    expect(await screen.findByText('GetTask')).toBeInTheDocument();
    expect(screen.getByText(`${messages.admin.logsServiceClient}: client-1`)).toBeInTheDocument();
    expect(screen.getByText('HTTP 200')).toBeInTheDocument();
    expect(screen.getByText(messages.admin.logsDetailStates.expired)).toBeInTheDocument();
    expect(container.innerHTML).not.toContain('private business text');
    expect(container.innerHTML).not.toContain('private attribute text');
    const next = new URL(screen.getByRole('link', { name: 'Older events' }).getAttribute('href')!, 'http://localhost');
    expect(Object.fromEntries(next.searchParams)).toEqual(expect.objectContaining({ domain: 'a2a', taskId: 'task-1', direction: 'inbound', until: until.toISOString(), cursor: 'next-page' }));
  });

  it('does not run summary or resource queries before admin authorization', async () => {
    mocks.authorizeLogs.mockRejectedValue(new Error('Forbidden'));
    await expect(AdminLogsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('Forbidden');
    expect(mocks.aggregateLogs).not.toHaveBeenCalled();
    expect(mocks.workspaces).not.toHaveBeenCalled();
    expect(mocks.auditCount).not.toHaveBeenCalled();
  });
});
