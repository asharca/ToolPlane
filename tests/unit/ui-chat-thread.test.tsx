import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useExternalStoreRuntime, type AttachmentAdapter, type ThreadMessageLike } from '@assistant-ui/react';
import { ChatThread } from '@asharca/ui';

describe('ChatThread runtime compatibility', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders Markdown and delegates file selection, cancellation and permissions to the runtime', async () => {
    const user = userEvent.setup();
    const add = vi.fn<AttachmentAdapter['add']>(async ({ file }) => ({
      id: file.name,
      type: 'file',
      name: file.name,
      contentType: file.type,
      file,
      status: { type: 'requires-action', reason: 'composer-send' },
    }));
    const attachments: AttachmentAdapter = {
      accept: 'text/plain',
      add,
      remove: async () => {},
      send: async (attachment) => ({ ...attachment, status: { type: 'complete' }, content: [] }),
    };

    function Harness({ allowAttachments = true }) {
      const runtime = useExternalStoreRuntime<ThreadMessageLike>({
        messages: [{ id: 'reply', role: 'assistant', content: [{ type: 'text', text: '**Ready** to read files.' }] }],
        convertMessage: (message) => message,
        isRunning: false,
        onNew: async () => {},
        adapters: { attachments },
      });
      return <ChatThread runtime={runtime} assistantName="Test assistant" allowAttachments={allowAttachments} />;
    }

    const { rerender } = render(<Harness />);
    expect(await screen.findByText('Ready')).toHaveAttribute('data-streamdown', 'strong');

    await user.click(screen.getByRole('button', { name: 'Open tools' }));
    await user.click(screen.getByRole('button', { name: 'Add attachment' }));
    const picker = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(picker).toHaveAttribute('accept', 'text/plain');
    expect(picker).toHaveAttribute('multiple');
    expect(screen.queryByRole('button', { name: 'Add attachment' })).not.toBeInTheDocument();

    const files = ['one.txt', 'two.txt'].map((name) => new File(['notes'], name, { type: 'text/plain' }));
    await user.upload(picker, files);
    await waitFor(() => expect(add).toHaveBeenCalledTimes(2));
    expect(add).toHaveBeenNthCalledWith(1, { file: files[0] });
    expect(add).toHaveBeenNthCalledWith(2, { file: files[1] });
    expect(await screen.findByText('one.txt')).toBeInTheDocument();
    expect(await screen.findByText('two.txt')).toBeInTheDocument();
    expect(picker).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open tools' }));
    await user.click(screen.getByRole('button', { name: 'Add attachment' }));
    const cancelledPicker = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent(cancelledPicker, new Event('cancel'));
    expect(cancelledPicker).not.toBeInTheDocument();
    expect(add).toHaveBeenCalledTimes(2);

    rerender(<Harness allowAttachments={false} />);
    await user.click(screen.getByRole('button', { name: 'Open tools' }));
    expect(screen.getByRole('button', { name: /Add attachment/ })).toBeDisabled();
  });
});
