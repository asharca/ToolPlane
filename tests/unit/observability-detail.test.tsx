import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import messages from '../../messages/en.json';
import ObservabilityDetailPage from '@/app/app/[workspace]/observability/[id]/page';
import type * as ObservabilityQueries from '@/lib/observability/queries';

const mocks = vi.hoisted(() => ({ user: vi.fn(), workspace: vi.fn(), event: vi.fn(), trace: vi.fn(),
  actor: vi.fn(), agent: vi.fn(), endpoint: vi.fn() }));
vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: mocks.user }));
vi.mock('@/lib/workspace/queries', () => ({ getWorkspaceForUser: mocks.workspace }));
vi.mock('@/lib/observability/queries', async original => ({
  ...await original<typeof ObservabilityQueries>(),
  getLogEvent: mocks.event, getLogTrace: mocks.trace,
}));
vi.mock('@/lib/db', () => ({ db: { user: { findUnique: mocks.actor }, agent: { findFirst: mocks.agent }, agentEndpoint: { findFirst: mocks.endpoint } } }));
vi.mock('next-intl/server', () => ({ getTranslations: async () => createTranslator({ locale: 'en', namespace: 'console.observability', messages }) }));

const row = {
  id: 'event-1', workspaceId: 'ws-1', domain: 'a2a', actorId: 'member-1', agentId: 'agent-1', rpcMethod: 'GetTask', eventName: 'a2a.request',
  traceId: 'trace-1', requestId: 'request-1', outcome: 'success', durationMs: 12, httpStatus: 200, createdAt: new Date(),
  attributes: { data: { a2a: { direction: 'inbound', transport: 'jsonrpc', taskId: 'task-1', rootTaskId: 'task-1' } } },
  detailState: 'restricted', detail: { data: { payload: { request: 'fixture-secret-must-not-render' } } },
};
beforeEach(() => {
  vi.clearAllMocks(); mocks.user.mockResolvedValue({ id: 'member-1', role: 'user' });
  mocks.workspace.mockResolvedValue({ id: 'ws-1', slug: 'owned' });
  mocks.event.mockResolvedValue(row); mocks.trace.mockResolvedValue([]);
  mocks.actor.mockResolvedValue({ name: 'Member' }); mocks.agent.mockResolvedValue({ name: 'Target' });
  mocks.endpoint.mockResolvedValue(null);
});
const page = (id = 'event-1', searchParams: Record<string, string> = {}) => ObservabilityDetailPage({
  params: Promise.resolve({ workspace: 'owned', id }), searchParams: Promise.resolve(searchParams),
});

describe('workspace A2A detail disclosure', () => {
  it('keeps stored bodies out of RSC even for an admin and confines return paths to the current workspace', async () => {
    mocks.user.mockResolvedValue({ id: 'admin-1', role: 'admin' });
    const { container } = render(await page('event-1', { returnTo: 'https://evil.invalid/steal', taskId: 'task-1', range: '24' }));
    expect(container.innerHTML).not.toContain('fixture-secret-must-not-render');
    expect(screen.getAllByText(messages.console.observability.bodyRestricted)).toHaveLength(2);
    expect(screen.getByRole('link', { name: messages.console.observability.a2aViewBodyAdmin })).toHaveAttribute('href', '/admin/logs/event-1');
    expect(screen.getByRole('link', { name: /Back to logs/ }).getAttribute('href')).toContain('/app/owned/observability?tab=a2a&taskId=task-1&range=24');
    expect(container.innerHTML).not.toContain('evil.invalid');
    expect(mocks.event).toHaveBeenCalledWith({ userId: 'admin-1', workspaceId: 'ws-1' }, 'event-1');
  });
  it('hides administrator body link from members and denies foreign event IDs without a trace lookup', async () => {
    render(await page());
    expect(screen.queryByRole('link', { name: messages.console.observability.a2aViewBodyAdmin })).not.toBeInTheDocument();
    mocks.event.mockResolvedValueOnce(null);
    await expect(page('foreign-event')).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
    expect(mocks.trace).toHaveBeenCalledTimes(1);
  });
});
