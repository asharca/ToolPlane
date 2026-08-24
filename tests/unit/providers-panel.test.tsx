import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ProvidersPanel } from '@/components/dashboard/agents/ProvidersPanel';

const actions = vi.hoisted(() => ({
  createProviderAction: vi.fn(async () => ({})),
  deleteProviderAction: vi.fn(async (formData: FormData) => {
    formData.get('providerId');
  }),
  refreshModelsAction: vi.fn(async (_state: unknown, formData: FormData) => {
    formData.get('providerId');
    return {};
  }),
  testProviderModelAction: vi.fn(async () => ({})),
  updateProviderAction: vi.fn(async () => ({})),
}));

vi.mock('@/lib/agents/actions', () => actions);

describe('ProvidersPanel', () => {
  it('closes the add-provider dialog with Escape and restores trigger focus', async () => {
    const user = userEvent.setup();
    render(<ProvidersPanel slug="acme" providers={[]} />);

    const trigger = screen.getByRole('button', { name: 'Add provider' });
    await user.click(trigger);

    expect(screen.getByRole('dialog', { name: 'Add model provider' })).toBeInTheDocument();

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Add model provider' })).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });
  });

  it('allows a Pi provider endpoint override while requiring one for custom providers', async () => {
    const user = userEvent.setup();
    render(
      <ProvidersPanel
        slug="acme"
        providers={[]}
        piProviderPresets={[{ format: 'pi:google', name: 'Google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' }]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Add provider' }));
    const baseUrl = screen.getByRole('textbox', { name: /^Base URL/ });
    expect(baseUrl).not.toBeRequired();
    expect(baseUrl).toHaveAttribute('placeholder', 'https://generativelanguage.googleapis.com/v1beta');
    expect(screen.getByText('Leave blank to use the built-in endpoint: https://generativelanguage.googleapis.com/v1beta')).toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Format' }), 'openai');
    expect(baseUrl).toBeRequired();
  });

  it('shows the built-in endpoint when a Pi provider has no override', () => {
    render(
      <ProvidersPanel
        slug="acme"
        providers={[{
          id: 'provider-1',
          name: 'Google',
          format: 'pi:google',
          baseUrl: '',
          modelCount: 1,
          models: ['gemini-2.5-pro'],
          modelsFetchedAt: null,
        }]}
        piProviderPresets={[{ format: 'pi:google', name: 'Google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' }]}
      />,
    );

    expect(screen.getByText('https://generativelanguage.googleapis.com/v1beta')).toBeInTheDocument();
  });

  it('puts model refresh inside the model list dialog', async () => {
    const user = userEvent.setup();
    render(
      <ProvidersPanel
        slug="acme"
        providers={[{
          id: 'provider-1',
          name: 'OpenAI production',
          format: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          modelCount: 1,
          models: ['gpt-4.1'],
          modelsFetchedAt: null,
        }]}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Refresh models' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'View models' }));
    await user.click(screen.getByRole('button', { name: 'Refresh models' }));

    await waitFor(() => expect(actions.refreshModelsAction).toHaveBeenCalledTimes(1));
    const formData = actions.refreshModelsAction.mock.calls[0][1] as FormData;
    expect(formData.get('workspace')).toBe('acme');
    expect(formData.get('providerId')).toBe('provider-1');
  });

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
            models: ['gpt-4.1', 'gpt-4.1-mini'],
            modelsFetchedAt: null,
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
