import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { NativeSelect } from '@/components/ui/NativeSelect';

describe('NativeSelect', () => {
  it('renders one consistently positioned chevron without changing select semantics', () => {
    const { container } = render(
      <NativeSelect
        aria-label="Runtime"
        className="ui-input h-9"
        wrapperClassName="flex-1"
      >
        <option value="native">Native</option>
      </NativeSelect>,
    );

    const select = screen.getByRole('combobox', { name: 'Runtime' });
    expect(select).toHaveClass('ui-select-control', 'ui-input', 'h-9');
    expect(select.parentElement).toHaveClass('ui-select', 'flex-1');
    expect(container.querySelectorAll('.ui-select-chevron')).toHaveLength(1);
    expect(container.querySelector('.ui-select-chevron')).toHaveAttribute('aria-hidden', 'true');
  });

  it('keeps the native disabled state and dims the decorative chevron', () => {
    const { container } = render(
      <NativeSelect aria-label="Model" disabled>
        <option value="">Select</option>
      </NativeSelect>,
    );

    expect(screen.getByRole('combobox', { name: 'Model' })).toBeDisabled();
    expect(container.querySelector('.ui-select-chevron')).toHaveClass('opacity-40');
  });
});
