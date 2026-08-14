import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { VariablesEditor } from '@/components/dashboard/VariablesEditor';

vi.mock('@/lib/workspace/actions', () => ({
  setDeploymentEnvAction: vi.fn(),
}));

function formChanges(): unknown {
  const input = document.querySelector('input[name="changes"]') as HTMLInputElement;
  return JSON.parse(input.value);
}

describe('VariablesEditor', () => {
  it('renders configured metadata without placing existing values in the DOM', () => {
    render(
      <VariablesEditor
        slug="acme"
        deploymentId="dep1"
        initial={[{ key: 'API_TOKEN', configured: true, required: true }]}
      />,
    );

    expect(screen.getByDisplayValue('API_TOKEN')).toBeDisabled();
    expect(screen.getByText('Configured')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('super-secret-value');
    expect(formChanges()).toEqual({ set: {}, remove: [] });
  });

  it('submits only an explicit replacement and keeps an untouched configured value out of the patch', () => {
    render(
      <VariablesEditor
        slug="acme"
        deploymentId="dep1"
        initial={[
          { key: 'API_TOKEN', configured: true, required: true },
          { key: 'KEEP_ME', configured: true, required: false },
        ]}
      />,
    );

    const replacement = screen.getAllByPlaceholderText('Enter a replacement value')[0];
    fireEvent.change(replacement, { target: { value: 'new-secret' } });

    expect(formChanges()).toEqual({
      set: { API_TOKEN: 'new-secret' },
      remove: [],
    });
  });

  it('marks removal explicitly instead of treating an empty password input as a delete', () => {
    render(
      <VariablesEditor
        slug="acme"
        deploymentId="dep1"
        initial={[{ key: 'API_TOKEN', configured: true, required: true }]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(screen.getByText('This variable will be removed when you save.')).toBeInTheDocument();
    expect(formChanges()).toEqual({ set: {}, remove: ['API_TOKEN'] });
  });
});
