import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentModelDialog } from '@/components/dashboard/agents/AgentModelDialog';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
const actions = vi.hoisted(() => ({
  updateAgentModelAction: vi.fn(async () => ({ savedAt: Date.now() })),
  updateHermesConversationSelectionAction: vi.fn(async () => ({})),
}));
vi.mock('@/lib/agents/actions', () => actions);

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('AgentModelDialog', () => {
  it('uses the shared runtime compatibility rule for the Work model picker', () => {
    render(
      <AgentModelDialog
        open
        onOpenChange={vi.fn()}
        slug="acme"
        agent={{
          id: 'agent-1',
          name: 'Claude worker',
          runtimeKind: 'claude-code',
          providerId: null,
          providerIds: [],
          model: null,
        }}
        providers={[
          { id: 'responses', name: 'Responses', format: 'openai-responses', models: ['gpt-5.6-luna'] },
          { id: 'pi-native', name: 'Pi native', format: 'pi:openai', models: ['gpt-native'] },
        ]}
        trigger={<button type="button">Model</button>}
      />,
    );

    expect(screen.getByText('gpt-5.6-luna')).toBeInTheDocument();
    expect(screen.queryByText('gpt-native')).not.toBeInTheDocument();
  });

  it('disables Hermes profile and model switching when the image needs an upgrade', async () => {
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

    render(
      <AgentModelDialog
        open
        onOpenChange={vi.fn()}
        slug="acme"
        agent={{
          id: 'agent-1',
          name: 'Hermes worker',
          runtimeKind: 'hermes',
          providerId: null,
          providerIds: [],
          model: null,
        }}
        providers={[]}
        hermesConversation={{
          id: 'conversation-1',
          profile: 'default',
          provider: 'openrouter',
          model: 'model-a',
          hasMessages: false,
          editable: true,
        }}
        trigger={<button type="button">Model</button>}
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Upgrade Hermes to switch profiles or models.');
    expect(screen.getByRole('combobox', { name: 'Hermes profile' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /Use profile default model/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /model-a/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns a new Work Hermes model as a draft without creating a Chat conversation', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('/hermes/profiles')) {
        return Response.json({
          profiles: [{ name: 'default', isDefault: true, provider: 'openrouter', model: 'model-a', description: '' }],
          profileChatSupported: true,
        });
      }
      return Response.json({
        profile: 'default',
        provider: 'openrouter',
        model: 'model-a',
        providers: [{ id: 'openrouter', name: 'OpenRouter', models: ['model-a', 'model-b'] }],
      });
    }));
    const onDraftChange = vi.fn();
    render(
      <AgentModelDialog
        open
        onOpenChange={vi.fn()}
        slug="acme"
        agent={{ id: 'agent-1', name: 'Hermes worker', runtimeKind: 'hermes', providerId: null, providerIds: [], model: null }}
        providers={[]}
        hermesConversation={{
          id: null,
          profile: 'default',
          provider: null,
          model: null,
          hasMessages: false,
          editable: true,
        }}
        onHermesDraftChange={onDraftChange}
        trigger={<button type="button">Model</button>}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Model configuration' });
    expect(await within(dialog).findByRole('combobox', { name: 'Hermes profile' })).toBeEnabled();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Use profile default model/ }));
    fireEvent.click(await within(dialog).findByRole('button', { name: /model-a/ }));
    fireEvent.click(await screen.findByRole('option', { name: 'model-b' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onDraftChange).toHaveBeenCalledWith({
      profile: 'default',
      provider: 'openrouter',
      model: 'model-b',
    }));
    expect(actions.updateHermesConversationSelectionAction).not.toHaveBeenCalled();
  });

  it('consumes each saved Hermes conversation selection only once', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      profiles: [{ name: 'default', isDefault: true, provider: 'openrouter', model: 'model-a', description: '' }],
      profileChatSupported: true,
    })));
    actions.updateHermesConversationSelectionAction.mockResolvedValueOnce({
      savedAt: 1,
      conversationId: 'conversation-1',
    });
    const saved = vi.fn();
    const conversation = {
      id: 'conversation-1',
      profile: 'default',
      provider: null,
      model: null,
      hasMessages: false,
      editable: true,
    };
    const view = (id: string, onSaved: () => void) => (
      <AgentModelDialog
        open
        onOpenChange={vi.fn()}
        slug="acme"
        agent={{ id: 'agent-1', name: 'Hermes worker', runtimeKind: 'hermes', providerId: null, providerIds: [], model: null }}
        providers={[]}
        hermesConversation={{ ...conversation, id }}
        onHermesSelectionSaved={onSaved}
        trigger={<button type="button">Model</button>}
      />
    );
    const { rerender } = render(view('conversation-1', saved));

    expect(await screen.findByRole('combobox', { name: 'Hermes profile' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));

    rerender(view('conversation-2', () => saved()));
    await Promise.resolve();
    expect(saved).toHaveBeenCalledTimes(1);
  });
});
