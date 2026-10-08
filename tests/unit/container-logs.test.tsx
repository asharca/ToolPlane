import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContainerLogs } from '@/components/dashboard/ContainerLogs';

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
const props = {
  deploymentId: 'deployment-1', initialSnapshot: { status: 'running', phase: 'ready', generation: 'g1' },
  initialLogs: { generation: 'g1', cursor: 0, nextCursor: 6, reset: false, text: 'first\n' },
  initialStatus: 'running', title: 'Runtime logs', refreshLabel: 'Refresh runtime', emptyLabel: 'No logs yet', unavailableLabel: 'Runtime unavailable',
  statusLabel: 'Status', phaseLabel: 'Phase', imageStateLabel: 'Image', containerStateLabel: 'Container', syncErrorLabel: 'Sync failed', truncatedLabel: 'Logs truncated',
};
const fetchMock = vi.fn();
function chunk(text: string, options: { generation?: string; reset?: boolean; status?: string } = {}) {
  return { ok: true, json: async () => ({ snapshot: { ...props.initialSnapshot, generation: options.generation ?? 'g1', status: options.status ?? 'running' }, logs: { generation: options.generation ?? 'g1', cursor: 6, nextCursor: 6 + new TextEncoder().encode(text).length, reset: options.reset ?? false, text } }) };
}
async function tick(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }

describe('ContainerLogs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    router.refresh.mockReset();
    fetchMock.mockReset().mockResolvedValue(chunk(''));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('preserves scroll-up position while appending and resumes on explicit follow', async () => {
    fetchMock.mockResolvedValueOnce(chunk('second\n')).mockResolvedValueOnce(chunk('third\n'));
    render(<ContainerLogs {...props} />);
    const viewport = screen.getByRole('region', { name: 'Runtime logs' });
    Object.defineProperties(viewport, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } });
    await tick(0);
    expect(viewport.scrollTop).toBe(1000);
    viewport.scrollTop = 120;
    fireEvent.scroll(viewport);
    expect(screen.getByRole('button', { name: 'Follow latest' })).toHaveAttribute('aria-pressed', 'false');
    await tick(3000);
    expect(viewport).toHaveTextContent('third');
    expect(viewport.scrollTop).toBe(120);
    fireEvent.click(screen.getByRole('button', { name: 'Follow latest' }));
    expect(viewport.scrollTop).toBe(1000);
  });

  it('filters and copies raw visible lines without losing the retained text', async () => {
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
    render(<ContainerLogs {...props} initialLogs={{ ...props.initialLogs, text: 'INFO one\nerror 中文\nINFO three\n' }} />);
    await tick(0);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search runtime logs…' }), { target: { value: 'ERROR' } });
    const viewport = screen.getByRole('region', { name: 'Runtime logs' });
    expect(viewport.textContent).toBe('error 中文');
    expect(screen.getByRole('button', { name: 'Follow latest' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Copy visible logs' }));
    await tick(0);
    expect(copy).toHaveBeenCalledWith('error 中文');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'absent' } });
    expect(viewport).toHaveTextContent('No matching log lines.');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } });
    expect(viewport.textContent).toBe('INFO one\nerror 中文\nINFO three\n');
    expect(screen.getByRole('button', { name: 'Follow latest' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('replaces old-generation text and explicit reset chunks while retaining preferences', async () => {
    fetchMock.mockResolvedValueOnce(chunk('second generation\n', { generation: 'g2' })).mockResolvedValueOnce(chunk('reset output\n', { generation: 'g2', reset: true }));
    render(<ContainerLogs {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Wrap lines' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'generation' } });
    await tick(0);
    expect(screen.getByRole('region').textContent).toBe('second generation');
    expect(screen.getByRole('button', { name: 'Wrap lines' })).toHaveAttribute('aria-pressed', 'false');
    await tick(3000);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } });
    expect(screen.getByRole('region').textContent).toBe('reset output\n');
  });

  it('retains output on network failure and allows a manual terminal-state retry', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(chunk('recovered\n', { status: 'stopped' }));
    render(<ContainerLogs {...props} initialSnapshot={{ ...props.initialSnapshot, status: 'stopped' }} initialStatus="stopped" />);
    await tick(0);
    expect(screen.getByText('Sync failed')).toBeInTheDocument();
    expect(screen.getByRole('region').textContent).toBe('first\n');
    await tick(10000);
    expect(screen.getByRole('region').textContent).toBe('first\n');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh runtime' }));
    await tick(0);
    expect(screen.queryByText('Sync failed')).not.toBeInTheDocument();
    expect(screen.getByRole('region').textContent).toBe('first\nrecovered\n');
  });

  it('keeps a UTF-8-safe 512 KiB tail without splitting Chinese characters', async () => {
    const text = '中文'.repeat(100000);
    fetchMock.mockResolvedValueOnce(chunk(text));
    render(<ContainerLogs {...props} />);
    await tick(0);
    const shown = screen.getByRole('region').textContent!;
    const expected = ('first\n' + text).slice(-Math.floor((512 * 1024) / 3));
    expect(shown).toBe(expected);
    expect(shown).not.toContain('�');
    expect(new TextEncoder().encode(shown).byteLength).toBeLessThanOrEqual(512 * 1024);
    expect(screen.getByText('Logs truncated')).toBeInTheDocument();
  });

  it('polls provisioning every second and keeps only stderr chunks from the endpoint', async () => {
    fetchMock.mockResolvedValueOnce(chunk('stderr startup\n', { status: 'provisioning' })).mockResolvedValueOnce(chunk('stderr progress\n', { status: 'provisioning' }));
    render(<ContainerLogs {...props} initialSnapshot={{ ...props.initialSnapshot, status: 'provisioning' }} initialStatus="provisioning" />);
    await tick(0);
    expect(screen.getByRole('region')).toHaveTextContent('stderr startup');
    await tick(999);
    expect(screen.getByRole('region')).not.toHaveTextContent('stderr progress');
    await tick(1);
    expect(screen.getByRole('region')).toHaveTextContent('stderr progress');
  });
});
