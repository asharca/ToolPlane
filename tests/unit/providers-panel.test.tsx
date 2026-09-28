import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProvidersPanel } from '@/components/dashboard/agents/ProvidersPanel';
import { defaultProviderModel } from '@/lib/agents/model-catalog';

const actions = vi.hoisted(() => ({
  addProviderModelAction: vi.fn(async (_state: unknown, formData: FormData) => {
    formData.get('modelId');
    return {};
  }),
  createProviderAction: vi.fn(async () => ({})),
  deleteProviderModelAction: vi.fn(async () => ({})),
  deleteProviderAction: vi.fn(async (formData: FormData) => {
    formData.get('providerId');
  }),
  testProviderModelAction: vi.fn(async () => ({})),
  updateProviderModelAction: vi.fn<(_state: unknown, _formData: FormData) => Promise<object>>(async () => ({})),
  updateProviderAction: vi.fn(async () => ({})),
}));

vi.mock('@/lib/agents/actions', () => actions);
vi.mock('@/lib/agents/model-reference-actions', () => ({ lookupProviderModelReferencesAction: vi.fn(async () => ({ matches: [] })) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ savedAt: 1 })));
});
afterEach(() => vi.unstubAllGlobals());

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

    await user.click(screen.getByRole('combobox', { name: 'Format' }));
    await user.click(screen.getByRole('option', { name: 'OpenAI-compatible' }));
    expect(baseUrl).toBeRequired();

    const dialog = screen.getByRole('dialog', { name: 'Add model provider' });
    const apiKey = within(dialog).getByLabelText('API key');
    await user.type(baseUrl, 'https://api.example.test/v1');
    await user.type(apiKey, 'provider-secret');
    await user.click(within(dialog).getByRole('button', { name: 'Add provider' }));
    await waitFor(() => expect(apiKey).toHaveValue(''));
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

  it('filters providers by model and shows the selected provider inline', async () => {
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
            modelCount: 1,
            models: ['gpt-4.1'],
            modelsFetchedAt: null,
          },
          {
            id: 'provider-2',
            name: 'Anthropic production',
            format: 'anthropic',
            baseUrl: 'https://api.anthropic.com',
            modelCount: 1,
            models: ['claude-sonnet-4'],
            modelsFetchedAt: null,
          },
        ]}
      />,
    );

    await user.type(screen.getByRole('textbox', { name: 'Search Model Providers' }), 'sonnet');
    expect(screen.queryByRole('button', { name: 'OpenAI production' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Anthropic production' }));
    expect(screen.getByText('https://api.anthropic.com')).toBeInTheDocument();

  });

  it('groups models and filters them by their persisted type', async () => {
    const user = userEvent.setup();
    render(
      <ProvidersPanel
        slug="acme"
        providers={[{
          id: 'provider-1',
          name: 'Acme AI',
          format: 'openai',
          baseUrl: 'https://api.acme.test/v1',
          modelCount: 2,
          models: ['gpt-5', 'acme/embed-v2'],
          modelRecords: [
            {
              modelId: 'gpt-5',
              name: 'GPT 5',
              group: 'ChatGPT',
              primaryType: 'text',
              capabilities: ['reasoning'],
              inputModalities: ['image'],
              contextWindow: 128000,
              maxInputTokens: null,
              maxOutputTokens: 32768,
              source: 'manual',
            },
            {
              modelId: 'acme/embed-v2',
              name: 'Acme Embed v2',
              group: 'Embeddings',
              primaryType: 'embedding',
              capabilities: [],
              inputModalities: [],
              contextWindow: 8192,
              maxInputTokens: null,
              maxOutputTokens: null,
              source: 'manual',
            },
          ],
          modelsFetchedAt: null,
        }]}
      />,
    );

    expect(screen.getByRole('button', { name: /ChatGPT/ })).toBeInTheDocument();
    expect(screen.getByText('GPT 5')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /Embedding/ }));
    expect(screen.getByText('Acme Embed v2')).toBeInTheDocument();
    expect(screen.queryByText('GPT 5')).not.toBeInTheDocument();
  });

  it('submits Cherry-style model identity, grouping, and classification fields', async () => {
    const user = userEvent.setup();
    actions.addProviderModelAction.mockClear();
    render(
      <ProvidersPanel
        slug="acme"
        providers={[{
          id: 'provider-1',
          name: 'OpenAI production',
          format: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          modelCount: 0,
          models: [],
          modelsFetchedAt: null,
        }]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Add model' }));
    const dialog = screen.getByRole('dialog', { name: 'Add model' });
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
    await user.type(within(dialog).getByRole('textbox', { name: /Model ID/ }), 'openai/gpt-image-1');
    expect(within(dialog).getByRole('textbox', { name: 'Model name' })).toHaveValue('openai/gpt-image-1');
    expect(within(dialog).getByRole('textbox', { name: 'Group name' })).toHaveValue('openai');

    await user.click(within(dialog).getByRole('button', { name: 'More settings' }));
    await user.click(within(dialog).getByRole('button', { name: 'Image' }));
    await user.click(within(dialog).getByRole('button', { name: 'Reasoning' }));
    await user.click(within(dialog).getByRole('button', { name: 'Vision' }));
    await user.type(within(dialog).getByRole('spinbutton', { name: 'Context window' }), '32768');
    await user.type(within(dialog).getByRole('spinbutton', { name: 'Input' }), '1.25');
    await user.type(within(dialog).getByRole('spinbutton', { name: 'Output' }), '8');
    await user.click(within(dialog).getByRole('button', { name: 'Add pricing tier' }));
    await user.click(within(dialog).getByRole('button', { name: 'Remove pricing tier' }));
    expect(within(dialog).queryByRole('spinbutton', { name: 'Input tokens above' })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'More settings' }));
    await user.click(within(dialog).getByRole('button', { name: 'Add model' }));

    await waitFor(() => expect(actions.addProviderModelAction).toHaveBeenCalledTimes(1));
    const formData = actions.addProviderModelAction.mock.calls[0][1] as FormData;
    expect(Object.fromEntries(formData)).toMatchObject({
      workspace: 'acme',
      providerId: 'provider-1',
      modelId: 'openai/gpt-image-1',
      name: 'openai/gpt-image-1',
      group: 'openai',
      primaryType: 'image',
      contextWindow: '32768',
    });
    expect(formData.getAll('capabilities')).toEqual(['reasoning']);
    expect(formData.getAll('inputModalities')).toEqual(['image']);
    expect(JSON.parse(String(formData.get('cost')))).toEqual({ input: 1.25, output: 8, cacheRead: 0, cacheWrite: 0 });
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
  it('closes creation before discovery finishes, preserves the provider on failure, and supports retry', async () => {
    const user = userEvent.setup();
    const discovery = Promise.withResolvers<Response>();
    vi.mocked(fetch).mockReturnValueOnce(discovery.promise);
    actions.createProviderAction.mockResolvedValueOnce({ providerId: 'new-provider', savedAt: 1 });
    const presets = [{ format: 'pi:google', name: 'Google', baseUrl: 'https://google.example' }];
    const { rerender } = render(<ProvidersPanel slug="acme" providers={[]} piProviderPresets={presets} />);
    await user.click(screen.getByRole('button', { name: 'Add provider' }));
    const dialog = screen.getByRole('dialog', { name: 'Add model provider' });
    await user.click(within(dialog).getByRole('button', { name: 'Add provider' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add model provider' })).not.toBeInTheDocument());
    const providers = [{ id: 'new-provider', name: 'Google', format: 'pi:google', baseUrl: '', modelCount: 0, models: [], modelsFetchedAt: null }];
    rerender(<ProvidersPanel slug="acme" providers={providers} piProviderPresets={presets} />);
    const provider = screen.getByRole('button', { name: 'Google' });
    expect(provider).toHaveAttribute('aria-pressed', 'true');
    expect(provider).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Refresh models' })).toBeDisabled();
    expect(screen.getByRole('status')).toBeInTheDocument();
    await act(async () => { discovery.resolve(Response.json({ error: 'Provider returned 503.' }, { status: 502 })); });
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(provider).toBeInTheDocument();
    expect(provider).not.toHaveAttribute('aria-busy');
    expect(screen.getByRole('button', { name: 'Refresh models' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Refresh models' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(provider).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh models' })).toBeEnabled();

    actions.createProviderAction.mockResolvedValueOnce({ error: 'Duplicate provider.' });
    await user.click(screen.getByRole('button', { name: 'Add provider' }));
    const secondDialog = screen.getByRole('dialog', { name: 'Add model provider' });
    await user.click(within(secondDialog).getByRole('button', { name: 'Add provider' }));
    await waitFor(() => expect(within(secondDialog).getByRole('alert')).toBeInTheDocument());
    expect(secondDialog).toBeInTheDocument();
  });

  it('edits thresholds and preserves distinct tiers after adding and removing a middle tier', async () => {
    const user = userEvent.setup();
    const cost = { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0, tiers: [{ inputTokensAbove: 200000, input: 2, output: 15, cacheRead: 0.2, cacheWrite: 0 }] };
    render(<ProvidersPanel slug="acme" providers={[{
      id: 'provider', name: 'Provider', format: 'openai', baseUrl: 'https://api.openai.com/v1', modelsFetchedAt: null,
      models: ['gpt-5'], modelCount: 1,
      modelRecords: [{ ...defaultProviderModel('gpt-5'), contextWindow: 400000, source: 'manual', cost }],
    }]} />);
    await user.click(screen.getByRole('button', { name: 'Edit model' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit model' });
    await user.click(within(dialog).getByRole('button', { name: 'More settings' }));
    expect(within(dialog).getByRole('spinbutton', { name: 'Context window' })).toHaveValue(400000);
    const inputPrices = within(dialog).getAllByRole('spinbutton', { name: 'Input' });
    expect(inputPrices[0]).toHaveValue(1.25);
    expect(inputPrices[1]).toHaveValue(2);
    await user.clear(inputPrices[0]);
    await user.type(inputPrices[0], '3');
    const threshold = within(dialog).getByRole('spinbutton', { name: 'Input tokens above' });
    await user.clear(threshold);
    await user.type(threshold, '272000');
    for (const [tokens, price] of [['500000', '6'], ['750000', '9']]) {
      await user.click(within(dialog).getByRole('button', { name: 'Add pricing tier' }));
      const thresholds = within(dialog).getAllByRole('spinbutton', { name: 'Input tokens above' });
      const prices = within(dialog).getAllByRole('spinbutton', { name: 'Input' });
      await user.clear(thresholds.at(-1)!);
      await user.type(thresholds.at(-1)!, tokens);
      await user.clear(prices.at(-1)!);
      await user.type(prices.at(-1)!, price);
    }
    await user.click(within(dialog).getAllByRole('button', { name: 'Remove pricing tier' })[1]);
    expect(within(dialog).getAllByRole('spinbutton', { name: 'Input tokens above' }).map((input) => (input as HTMLInputElement).value)).toEqual(['272000', '750000']);
    expect(within(dialog).getAllByRole('spinbutton', { name: 'Input' }).map((input) => (input as HTMLInputElement).value)).toEqual(['3', '2', '9']);
    await user.click(within(dialog).getByRole('button', { name: 'More settings' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(actions.updateProviderModelAction).toHaveBeenCalledTimes(1));
    const formData = actions.updateProviderModelAction.mock.calls[0][1] as FormData;
    expect(JSON.parse(String(formData.get('cost')))).toEqual({
      ...cost, input: 3, tiers: [
        { ...cost.tiers[0], inputTokensAbove: 272000 },
        { inputTokensAbove: 750000, input: 9, output: 10, cacheRead: 0.125, cacheWrite: 0 },
      ],
    });
    expect(formData.get('contextWindow')).toBe('400000');
  });
  it('shows persisted prices and limits for each model, including tiers, without assigning metadata to unknown models', () => {
    render(<ProvidersPanel slug="acme" providers={[{
      id: 'provider', name: 'Provider', format: 'openai', baseUrl: 'https://example.test', modelsFetchedAt: null,
      models: ['known-a', 'local-alias', 'unknown'], modelCount: 3,
      modelRecords: [
        { ...defaultProviderModel('known-a'), name: 'Known A', contextWindow: 1000, source: 'remote', cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5, tiers: [{ inputTokensAbove: 2000, input: 5, output: 6, cacheRead: 0.3, cacheWrite: 0.7 }] } },
        { ...defaultProviderModel('local-alias'), name: 'Known B', contextWindow: 128, source: 'manual', cost: { input: 3, output: 4, cacheRead: 0.2, cacheWrite: 0.6 } },
      ],
    }]} />);
    const first = screen.getByRole('article', { name: 'Known A' });
    const alias = screen.getByRole('article', { name: 'Known B' });
    expect(within(first).getByText('$1.00')).toBeInTheDocument();
    expect(within(first).getByText('$5.00')).toBeInTheDocument();
    expect(within(first).getByText('Input > 2,000 tokens')).toBeInTheDocument();
    expect(within(first).queryByText('$3.00')).not.toBeInTheDocument();
    expect(within(alias).getByText('$3.00')).toBeInTheDocument();
    expect(within(alias).queryByText('$1.00')).not.toBeInTheDocument();
    expect(within(first).getByText('1,000')).toBeInTheDocument();
    expect(within(alias).getByText('128')).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: 'unknown' })).queryByText(/\$/)).not.toBeInTheDocument();
  });
});
