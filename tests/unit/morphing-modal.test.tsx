import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MorphingModal } from '@/components/motion/morphing-modal';

describe('MorphingModal', () => {
  it('portals modal chrome outside the clipped consumer and closes from the backdrop', async () => {
    const onClose = vi.fn();
    const { container } = render(
      <div className="overflow-hidden transform">
        <MorphingModal viewId="details" onClose={onClose}>
          <p>Details view</p>
        </MorphingModal>
      </div>,
    );

    const content = screen.getByText('Details view');
    expect(container).not.toContainElement(content);
    expect(document.body).toContainElement(content);

    await userEvent.click(screen.getByRole('button', { name: 'Close modal' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
