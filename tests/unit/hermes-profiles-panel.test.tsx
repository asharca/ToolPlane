import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HermesProfilesPanel } from '@/components/dashboard/agents/HermesProfilesPanel';

const actions = vi.hoisted(() => ({
  update: vi.fn(async (...args: [unknown, FormData]) => {
    void args;
    return {};
  }),
}));

vi.mock('@/lib/agents/actions', () => ({
  updateHermesProfileDefaultModelAction: actions.update,
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('HermesProfilesPanel', () => {
  it('saves the selected default model for one Hermes profile', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/hermes/profiles')) {
        return Response.json({
          profiles: [{
            name: 'default',
            isDefault: true,
            provider: 'openrouter',
            model: 'model-a',
            description: '',
          }, {
            name: 'research',
            isDefault: false,
            provider: 'openrouter',
            model: 'model-a',
            description: '',
          }],
          profileChatSupported: true,
        });
      }
      return Response.json({
        profile: new URL(url, 'https://toolplane.test').searchParams.get('profile'),
        provider: 'openrouter',
        model: 'model-a',
        providers: [{ id: 'openrouter', name: 'OpenRouter', models: ['model-a', 'model-b'] }],
      });
    }));

    render(<HermesProfilesPanel slug="acme" agentId="agent-1" />);

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Hermes profile' })).toBeEnabled());
    expect(screen.getByRole('combobox', { name: 'Hermes profile' })).toHaveTextContent('default');
    await userEvent.click(screen.getByRole('combobox', { name: 'Hermes profile' }));
    await userEvent.click(await screen.findByRole('option', { name: 'research' }));
    expect(screen.getByRole('combobox', { name: 'Hermes profile' })).toHaveTextContent('research');
    await waitFor(() => expect(screen.getByRole('button', { name: /model-a/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /model-a/ }));
    fireEvent.click(await screen.findByRole('option', { name: 'model-b' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(actions.update).toHaveBeenCalledTimes(1));
    const formData = actions.update.mock.calls[0][1] as FormData;
    expect(formData.get('workspace')).toBe('acme');
    expect(formData.get('agentId')).toBe('agent-1');
    expect(formData.get('profile')).toBe('research');
    expect(formData.get('provider')).toBe('openrouter');
    expect(formData.get('model')).toBe('model-b');
  });

  it('disables profile defaults when the Hermes image needs an upgrade', async () => {
    const fetchMock = vi.fn(async () => Response.json({
      profiles: [{
        name: 'default',
        isDefault: true,
        provider: 'openrouter',
        model: 'model-a',
        description: '',
      }],
      profileChatSupported: false,
    }));
    vi.stubGlobal('fetch', fetchMock);

    render(<HermesProfilesPanel slug="acme" agentId="agent-1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Upgrade Hermes to switch profiles or models.');
    expect(screen.getByRole('combobox', { name: 'Hermes profile' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /model-a/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
