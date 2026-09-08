import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { replaceMock } = vi.hoisted(() => ({ replaceMock: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => new URLSearchParams('returnTo=%2Fapp%2Facme%2Fmcp%3F__dashboardTab%3Dtab-1'),
}));

import { SettingsModal } from '@/components/dashboard/SettingsModal';

describe('SettingsModal', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('keeps unsaved settings open until the user confirms leaving', async () => {
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<SettingsModal title="Settings" fallbackHref="/app/acme/chat"><form><input aria-label="Name" defaultValue="Saved" /></form></SettingsModal>);
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), ' edit');
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(confirm).toHaveBeenCalled();
    expect(replaceMock).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(replaceMock).toHaveBeenCalledWith('/app/acme/mcp?__dashboardTab=tab-1');
  });

  it('closes directly to the page that opened it', async () => {
    render(
      <SettingsModal title="Settings" fallbackHref="/app/acme/chat">
        Content
      </SettingsModal>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(replaceMock).toHaveBeenCalledWith('/app/acme/mcp?__dashboardTab=tab-1');
  });

  it('keeps compact modals full-screen on mobile and constrains them on larger screens', () => {
    render(
      <SettingsModal title="Settings" fallbackHref="/app/acme/chat" compact>
        Content
      </SettingsModal>,
    );

    expect(screen.getByRole('dialog')).toHaveClass(
      '!h-full',
      '!w-full',
      '!rounded-none',
      'sm:!h-[min(600px,76vh)]',
      'sm:!max-w-[720px]',
    );
  });
});
