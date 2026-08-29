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
    const list = screen.getByRole('listbox', { name: 'Select model' });
    expect(within(list).getByRole('option', { name: 'custom-model' })).toHaveAttribute('aria-selected', 'true');
    expect(within(list).getAllByRole('option', { name: 'gpt-4.1' })).toHaveLength(1);

    await userEvent.type(screen.getByRole('textbox', { name: 'Search models...' }), 'claude');
    expect(screen.queryByRole('group', { name: 'OpenAI' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('option', { name: 'claude-sonnet' }));

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith({ providerId: 'anthropic', model: 'claude-sonnet' });
    expect(screen.queryByRole('listbox', { name: 'Select model' })).not.toBeInTheDocument();
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
});
