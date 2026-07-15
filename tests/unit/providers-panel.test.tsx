import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ProvidersPanel } from '@/components/dashboard/agents/ProvidersPanel';

const actions = vi.hoisted(() => ({
  createProviderAction: vi.fn(async () => ({})),
  deleteProviderAction: vi.fn(async (formData: FormData) => {
    formData.get('providerId');
  }),
  refreshModelsAction: vi.fn(async () => ({})),
}));

vi.mock('@/lib/agents/actions', () => actions);

describe('ProvidersPanel', () => {
  it('requires confirmation before deleting a provider', async () => {
    const user = userEvent.setup();
    render(
      <ProvidersPanel
        slug="acme"
        providers={[
          {
            id: 'provider-1',
            name: 'OpenAI production',
            format: 'openai',
            baseUrl: 'https://api.openai.com/v1',
            modelCount: 2,
          },
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Remove' }));

    expect(actions.deleteProviderAction).not.toHaveBeenCalled();
    expect(screen.getByText(
      'Remove OpenAI production? Agents using this provider will need a new provider and model.',
    )).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(actions.deleteProviderAction).toHaveBeenCalledTimes(1));
    const formData = actions.deleteProviderAction.mock.calls[0][0] as FormData;
    expect(formData.get('workspace')).toBe('acme');
    expect(formData.get('providerId')).toBe('provider-1');
  });
});
