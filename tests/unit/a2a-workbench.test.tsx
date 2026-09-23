import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskState, Task } from '@a2a-js/sdk';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), push: vi.fn(), replace: vi.fn(), monitor: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push, replace: mocks.replace }) }));
vi.mock('@/components/dashboard/CopyButton', () => ({ CopyButton: () => null }));
vi.mock('@/components/dashboard/agents/AgentA2ATaskMonitor', () => ({ AgentA2ATaskMonitor: (props: unknown) => { mocks.monitor(props); return <div>Task monitor</div>; } }));
vi.mock('@/lib/a2a/workbench-client', async (original) => ({ ...await original<typeof import('@/lib/a2a/workbench-client')>(), workbenchRpc: mocks.rpc }));
import { A2AWorkbench } from '@/components/dashboard/work/A2AWorkbench';
const wire = (state = TaskState.TASK_STATE_COMPLETED, id = 'task-1') => Task.toJSON(Task.fromJSON({ id, contextId: 'ctx-1', status: { state } }));
const agents = [{ id: 'a', name: 'Coordinator', runtimeKind: 'pi', enabled: true, configured: true }];
const show = (initialTaskId?: string, enabled = true) => render(<A2AWorkbench slug="ws" agents={agents.map((agent) => ({ ...agent, enabled }))} agentId="a" initialTaskId={initialTaskId} />);
const sends = () => mocks.rpc.mock.calls.filter((call) => call[1] === 'SendMessage');
beforeEach(() => {
  vi.clearAllMocks(); vi.spyOn(window, 'confirm').mockReturnValue(true);
  mocks.rpc.mockImplementation(async (_base, method) => method === 'ListTasks' ? { tasks: [wire()], nextPageToken: '' }
    : method === 'SendMessage' ? { task: wire(TaskState.TASK_STATE_SUBMITTED, 'new-task') } : wire());
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe('daily A2A workbench', () => {
  it('opening a task only reads and restores its identity; it does not execute old Work', async () => {
    show('task-1'); await screen.findByText('Task monitor');
    expect(sends()).toHaveLength(0);
    expect(mocks.rpc).toHaveBeenCalledWith(expect.stringContaining('/a2a/console'), 'GetTask', { id: 'task-1', historyLength: 0 }, expect.anything());
    expect(mocks.monitor).toHaveBeenCalledWith(expect.objectContaining({ rootTaskId: 'task-1', showHistory: true }));
  });
  it('submits a new native task and updates the recoverable URL', async () => {
    show(); await waitFor(() => expect(mocks.rpc).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('Task goal'), { target: { value: 'Review the implementation' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit task' }));
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/app/ws/work?mode=a2a&agent=a&task=new-task', { scroll: false }));
    expect(sends()).toHaveLength(1); expect(sends()[0][2]).toMatchObject({ configuration: { returnImmediately: true }, message: { parts: [{ text: 'Review the implementation' }] } });
  });
  it('creates a follow-up in the same context without reopening a completed task', async () => {
    show('task-1'); await screen.findByText('Task monitor');
    fireEvent.change(screen.getByLabelText('Follow-up message'), { target: { value: 'Refine the report' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create follow-up task' }));
    await waitFor(() => expect(sends()).toHaveLength(1));
    const message = sends()[0][2].message;
    expect(message).toMatchObject({ contextId: 'ctx-1', referenceTaskIds: ['task-1'] }); expect(message.taskId).toBeUndefined();
  });
  it('retains the exact send on failure and retries only on explicit user action', async () => {
    show(); await waitFor(() => expect(mocks.rpc).toHaveBeenCalled());
    mocks.rpc.mockImplementation(async (_base, method) => { if (method === 'SendMessage') throw new Error('network loss'); return { tasks: [], nextPageToken: '' }; });
    fireEvent.change(screen.getByLabelText('Task goal'), { target: { value: 'Do this once' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit task' }));
    await screen.findByRole('alert'); expect(sends()).toHaveLength(1);
    const first = structuredClone(sends()[0][2]);
    expect(screen.getByLabelText('Task goal')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry the same message' }));
    await waitFor(() => expect(sends()).toHaveLength(2)); expect(sends()[1][2]).toEqual(first);
    expect(mocks.replace).not.toHaveBeenCalled();
  });
  it('does not send while disabled, loading, or waiting for authorization', async () => {
    const rendered = show(undefined, false);
    expect(screen.getByRole('button', { name: 'Submit task' })).toBeDisabled(); expect(mocks.rpc).not.toHaveBeenCalled();
    rendered.unmount();
    mocks.rpc.mockImplementation(async (_base, method) => method === 'ListTasks' ? { tasks: [], nextPageToken: '' } : wire(TaskState.TASK_STATE_AUTH_REQUIRED));
    show('task-1'); await screen.findByText('Task monitor');
    expect(screen.getByLabelText('Follow-up message')).toBeDisabled(); expect(sends()).toHaveLength(0);
  });
  it('rejects a mismatched task lookup rather than creating a task accidentally', async () => {
    mocks.rpc.mockImplementation(async (_base, method) => method === 'ListTasks' ? { tasks: [], nextPageToken: '' } : wire(3, 'another-task'));
    show('task-1'); await screen.findByText(/This task is unavailable/);
    expect(screen.getByRole('button', { name: 'Submit task' })).toBeDisabled(); expect(sends()).toHaveLength(0);
  });
  it('sends input only after the root task requests it and cancellation is not a submit', async () => {
    mocks.rpc.mockImplementation(async (_base, method) => method === 'ListTasks' ? { tasks: [], nextPageToken: '' } : wire(TaskState.TASK_STATE_WORKING));
    show('task-1'); await screen.findByText('Task monitor');
    expect(screen.getByLabelText('Follow-up message')).toBeDisabled();
    act(() => mocks.monitor.mock.lastCall![0].onRootState('TASK_STATE_INPUT_REQUIRED'));
    fireEvent.change(screen.getByLabelText('Additional information'), { target: { value: 'main' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request cancellation' }));
    await waitFor(() => expect(mocks.rpc.mock.calls.some((call) => call[1] === 'CancelTask')).toBe(true));
    expect(sends()).toHaveLength(0);
  });
  it('ignores late results and aborts requests when leaving the page', async () => {
    let resolve: (value: unknown) => void;
    mocks.rpc.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const rendered = show(); const signal = mocks.rpc.mock.calls[0][3] as AbortSignal;
    rendered.unmount(); expect(signal.aborted).toBe(true);
    await act(async () => resolve!({ tasks: [], nextPageToken: '' })); expect(mocks.replace).not.toHaveBeenCalled();
  });
});


describe('native follow-up boundary', () => {
  it('sends INPUT_REQUIRED input to the existing task without creating another context', async () => {
    mocks.rpc.mockImplementation(async (_base, method) => method === 'ListTasks' ? { tasks: [], nextPageToken: '' }
      : method === 'SendMessage' ? { task: wire(TaskState.TASK_STATE_SUBMITTED) } : wire(TaskState.TASK_STATE_INPUT_REQUIRED));
    show('task-1'); await screen.findByText('Task monitor');
    fireEvent.change(screen.getByLabelText('Additional information'), { target: { value: 'main branch' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send additional information' }));
    await waitFor(() => expect(mocks.replace).toHaveBeenCalled());
    expect(sends()[0][2].message).toMatchObject({ taskId: 'task-1', contextId: 'ctx-1', parts: [{ text: 'main branch' }] });
  });
  it('blocks follow-up when the live task monitor reports revoked access', async () => {
    show('task-1'); await screen.findByText('Task monitor');
    act(() => mocks.monitor.mock.lastCall![0].onUnavailable());
    expect(screen.getByRole('button', { name: 'Create follow-up task' })).toBeDisabled(); expect(sends()).toHaveLength(0);
  });
  it('clears an unsent draft when starting a new context at the blank entry', async () => {
    show(); await waitFor(() => expect(mocks.rpc).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('Task goal'), { target: { value: 'old draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'New context' }));
    expect(screen.getByLabelText('Task goal')).toHaveValue(''); expect(sends()).toHaveLength(0);
  });
});


it('retries a failed initial lookup only when requested without creating work', async () => {
  mocks.rpc.mockImplementation(async (_base, method) => { if (method === 'GetTask') throw new Error('offline'); return { tasks: [], nextPageToken: '' }; });
  show('task-1'); await screen.findByText(/This task is unavailable/);
  mocks.rpc.mockImplementation(async (_base, method) => method === 'ListTasks' ? { tasks: [], nextPageToken: '' } : wire());
  fireEvent.click(screen.getByRole('button', { name: 'Retry task lookup' }));
  await screen.findByText('Task monitor'); expect(sends()).toHaveLength(0);
});
