import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ModelPicker } from '@/components/dashboard/models/ModelPicker';

describe('ModelPicker', () => {
  it('searches grouped providers, keeps the current model, and selects once', async () => {
    const onSelect = vi.fn();
    render(
      <ModelPicker
        providers={[
          { id: 'openai', name: 'OpenAI', models: ['gpt-4.1', 'gpt-4.1'] },
          { id: 'anthropic', name: 'Anthropic', models: ['claude-sonnet'] },
        ]}
        value={{ providerId: 'openai', model: 'custom-model' }}
        onSelect={onSelect}
        trigger={<button type="button">Choose model</button>}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Choose model' }));
    const list = await screen.findByRole('listbox', { name: 'Select model' });
    expect(within(list).getByRole('option', { name: 'custom-model' })).toHaveAttribute('aria-selected', 'true');
    expect(within(list).getAllByRole('option', { name: 'gpt-4.1' })).toHaveLength(1);

    await userEvent.type(screen.getByRole('textbox', { name: 'Search models...' }), 'claude');
    expect(screen.queryByRole('option', { name: 'gpt-4.1' })).not.toBeInTheDocument();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('option', { name: 'claude-sonnet' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith({ providerId: 'anthropic', model: 'claude-sonnet' });
    expect(screen.getByRole('button', { name: 'Choose model' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows stored model capabilities and infers a missing model type', async () => {
    render(
      <ModelPicker
        providers={[{
          id: 'openai',
          name: 'OpenAI',
          models: ['plain-model', 'text-embedding-3-small'],
          modelRecords: [{
            modelId: 'plain-model',
            primaryType: 'image',
            capabilities: ['reasoning', 'function_calling'],
            inputModalities: ['image', 'audio', 'video'],
          }],
        }]}
        value={null}
        onSelect={vi.fn()}
        trigger={<button type="button">Choose typed model</button>}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Choose typed model' }));

    expect(screen.getByText('Image')).toBeInTheDocument();
    expect(screen.getByTitle('Embedding')).toBeInTheDocument();
    expect(screen.getByTitle('Reasoning')).toBeInTheDocument();
    expect(screen.getByTitle('Tools')).toBeInTheDocument();
    expect(screen.getByTitle('Vision')).toBeInTheDocument();
    expect(screen.getByTitle('Audio')).toBeInTheDocument();
    expect(screen.getByTitle('Video')).toBeInTheDocument();
  });

  it('shows prices without treating missing rates as free and searches collapsed providers', async () => {
    render(<ModelPicker
      providers={[{ id: 'provider', name: 'Provider', models: ['priced', 'unknown'], modelRecords: [
        { modelId: 'priced', primaryType: 'text', cost: { input: 0, output: 0.125 } },
      ] }]}
      value={null} onSelect={vi.fn()} trigger={<button>Choose prices</button>}
    />);
    await userEvent.click(screen.getByRole('button', { name: 'Choose prices' }));
    expect(within(screen.getByRole('option', { name: 'priced' })).getByText('Input 0 $/M')).toBeInTheDocument();
    expect(within(screen.getByRole('option', { name: 'priced' })).getByText('Output 0.125 $/M')).toBeInTheDocument();
    expect(within(screen.getByRole('option', { name: 'unknown' })).getByText('Input — $/M')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Provider' }));
    expect(screen.queryByRole('option', { name: 'priced' })).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: 'Search models...' }), 'priced');
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('option', { name: 'priced' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Clear model search' }));
    expect(screen.queryByRole('option', { name: 'priced' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Provider' }));
    expect(screen.getByRole('option', { name: 'unknown' })).toBeVisible();
  });

  it('skips collapsed provider models during keyboard navigation', async () => {
    render(<ModelPicker
      providers={[
        { id: 'first', name: 'First', models: ['hidden-model'] },
        { id: 'second', name: 'Second', models: ['visible-one', 'visible-two'] },
      ]}
      value={null} onSelect={vi.fn()} trigger={<button>Choose model</button>}
    />);
    await userEvent.click(screen.getByRole('button', { name: 'Choose model' }));
    const provider = screen.getByRole('button', { name: 'First' });
    await userEvent.click(provider);
    expect(provider).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('option', { name: 'hidden-model' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('textbox', { name: 'Search models...' }));
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('option', { name: 'visible-one' })).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    expect(screen.getByRole('option', { name: 'visible-two' })).toHaveFocus();
    await userEvent.click(provider);
    expect(provider).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(screen.getByRole('textbox', { name: 'Search models...' }));
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('option', { name: 'hidden-model' })).toHaveFocus();
  });

  it('dismisses with Escape and returns focus to the model trigger', async () => {
    render(<ModelPicker providers={[{ id: 'provider', name: 'Provider', models: ['model'] }]}
      value={null} onSelect={vi.fn()} trigger={<button>Choose model</button>} />);
    const trigger = screen.getByRole('button', { name: 'Choose model' });
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole('textbox', { name: 'Search models...' }));
    await userEvent.keyboard('{Escape}');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
  });
});
