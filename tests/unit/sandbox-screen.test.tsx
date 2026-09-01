import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SandboxScreen } from '@/components/dashboard/sandboxes/SandboxScreen';
import { SandboxWorkspace } from '@/components/dashboard/sandboxes/SandboxWorkspace';

const rfbMocks = vi.hoisted(() => ({
  construct: vi.fn(),
  disconnect: vi.fn(),
  focus: vi.fn(),
  sendKey: vi.fn(),
}));

vi.mock('@novnc/novnc', () => ({
  default: class extends EventTarget {
    viewOnly = false;
    scaleViewport = false;
    focusOnClick = true;
    constructor(target: HTMLElement, url: string) {
      super();
      rfbMocks.construct(target, url, this);
    }
    disconnect() { rfbMocks.disconnect(); }
    focus() { rfbMocks.focus(); }
    sendKey(keysym: number, code?: string, down?: boolean) { rfbMocks.sendKey(keysym, code, down); }
    sendCredentials() {}
  },
}));

vi.mock('@/components/dashboard/sandboxes/SandboxConsole', () => ({
  SandboxConsole: ({ terminalOnly, filesOnly }: { terminalOnly?: boolean; filesOnly?: boolean }) => (
    <div>{terminalOnly ? 'terminal panel' : filesOnly ? 'files panel' : 'console'}</div>
  ),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

const consoleProps = {
  deploymentId: 'dep-1',
  running: true,
  initialPath: '.',
  initialEntries: [],
};

describe('sandbox screen workspace', () => {
  it('keeps terminal and files tabs stable and only adds screen for advertised displays', async () => {
    const { rerender } = render(
      <SandboxWorkspace workspace="acme" sandboxId="box-1" displays={[]} {...consoleProps} />,
    );

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Terminal', 'Files']);
    expect(screen.queryByRole('tab', { name: 'Screen' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Files' }));
    expect(screen.getByText('files panel')).toBeInTheDocument();

    rerender(
      <SandboxWorkspace
        workspace="acme"
        sandboxId="box-1"
        displays={[{ id: 'main', label: 'Phone', transport: 'snapshot', control: false }]}
        {...consoleProps}
      />,
    );
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Terminal', 'Files', 'Screen']);
  });

  it('pauses frame polling while the page is hidden', () => {
    vi.useFakeTimers();
    render(
      <SandboxScreen
        workspace="acme"
        sandboxId="box-1"
        displays={[{ id: 'main', label: 'Phone', transport: 'snapshot', control: false }]}
        running
      />,
    );
    const image = screen.getByRole('img', { name: 'Phone screen' });
    const initial = image.getAttribute('src');

    fireEvent.load(image);
    act(() => vi.advanceTimersByTime(1100));
    expect(image.getAttribute('src')).not.toBe(initial);
    const pending = image.getAttribute('src');
    act(() => vi.advanceTimersByTime(2100));
    expect(image.getAttribute('src')).toBe(pending);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    const hidden = image.getAttribute('src');
    act(() => vi.advanceTimersByTime(2100));
    expect(image.getAttribute('src')).toBe(hidden);
  });

  it('starts RFB read-only, preserves control, and supports mobile input', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ viewerUrl: 'wss://example.test/session' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <SandboxScreen
        workspace="acme"
        sandboxId="box-1"
        displays={[{ id: 'main', label: 'Desktop', transport: 'rfb', control: true }]}
        running
      />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/workspaces/acme/sandboxes/box-1/screen/sessions',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ displayId: 'main' }) }),
    ));
    await waitFor(() => expect(rfbMocks.construct).toHaveBeenCalledWith(
      screen.getByTestId('rfb-target'),
      'wss://example.test/session',
      expect.objectContaining({ viewOnly: true, scaleViewport: true }),
    ));
    const control = screen.getByRole('checkbox', { name: 'Control' });
    expect(control).not.toBeChecked();

    await userEvent.click(control);
    const client = rfbMocks.construct.mock.calls.at(-1)?.[2] as EventTarget & {
      focusOnClick: boolean;
      viewOnly: boolean;
    };
    expect(client.viewOnly).toBe(false);
    expect(rfbMocks.focus).toHaveBeenCalledOnce();

    act(() => client.dispatchEvent(new Event('connect')));
    await userEvent.click(screen.getByRole('button', { name: 'On-screen keyboard' }));
    const keyboardInput = screen.getByRole('textbox', { name: 'Remote keyboard input' });
    expect(keyboardInput).toHaveFocus();
    expect(client.focusOnClick).toBe(false);
    await userEvent.type(keyboardInput, 'a{Enter}{Backspace}');
    expect(rfbMocks.sendKey).toHaveBeenCalledWith(97, undefined, undefined);
    expect(rfbMocks.sendKey).toHaveBeenCalledWith(0xff0d, 'Enter', true);
    expect(rfbMocks.sendKey).toHaveBeenCalledWith(0xff08, 'Backspace', true);
    expect(fireEvent.mouseDown(screen.getByTestId('rfb-target'))).toBe(false);
    expect(keyboardInput).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'On-screen keyboard' }));
    expect(keyboardInput).not.toHaveFocus();
    expect(client.focusOnClick).toBe(true);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    act(() => document.dispatchEvent(new Event('visibilitychange')));

    await waitFor(() => expect(rfbMocks.construct).toHaveBeenCalledTimes(2));
    const reconnected = rfbMocks.construct.mock.calls.at(-1)?.[2] as { viewOnly: boolean };
    expect(reconnected.viewOnly).toBe(false);
  });

  it.each(['disconnect', 'securityfailure'])('retries RFB after %s', async (eventName) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ viewerUrl: 'wss://example.test/first' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ viewerUrl: 'wss://example.test/second' }) });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <SandboxScreen
        workspace="acme"
        sandboxId="box-1"
        displays={[{ id: 'main', label: 'Desktop', transport: 'rfb', control: true }]}
        running
      />,
    );

    await waitFor(() => expect(rfbMocks.construct).toHaveBeenCalledOnce());
    const client = rfbMocks.construct.mock.calls[0][2] as EventTarget;
    act(() => client.dispatchEvent(new Event(eventName)));
    expect(screen.getByRole('alert')).toHaveTextContent('The screen is unavailable.');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/v1/workspaces/acme/sandboxes/box-1/screen/sessions',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ displayId: 'main' }) }),
    ));
    await waitFor(() => expect(rfbMocks.construct).toHaveBeenNthCalledWith(
      2,
      screen.getByTestId('rfb-target'),
      'wss://example.test/second',
      expect.anything(),
    ));
  });
});
