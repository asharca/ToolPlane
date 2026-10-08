import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ModelPicker } from '@/components/dashboard/models/ModelPicker';

const trigger = <button type="button">Choose model</button>;
const searchBox = () => screen.getByRole('combobox');

// Duplicate names must still select the correct credential-bearing provider.
const providers = [
  { id: 'first', name: 'Provider', models: ['shared-model', 'shared-model'] },
  { id: 'second', name: 'Provider', models: ['shared-model', 'other-model'] },
];

describe('ModelPicker', () => {
  it('keeps uncached selections and distinguishes providers with identical names', async () => {
    const onSelect = vi.fn();
    render(<ModelPicker providers={providers} value={{ providerId: 'first', model: 'custom-model' }}
      onSelect={onSelect} trigger={trigger} />);
    await userEvent.click(screen.getByRole('button', { name: 'Choose model' }));
    const list = await screen.findByRole('listbox');
    expect(within(list).getByRole('option', { name: 'custom-model' })).toHaveAttribute('aria-selected', 'true');
    const shared = within(list).getAllByRole('option', { name: 'shared-model' });
    expect(shared).toHaveLength(2);
    await userEvent.click(shared[1]);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({ providerId: 'second', model: 'shared-model' });
    expect(screen.getByRole('button', { name: 'Choose model' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('searches capabilities and resets keyboard selection when the query changes', async () => {
    const onSelect = vi.fn();
    render(<ModelPicker providers={[{ id: 'provider', name: 'Provider', models: ['plain', 'smart', 'tools'],
      modelRecords: [
        { modelId: 'smart', primaryType: 'text', capabilities: ['reasoning'] },
        { modelId: 'tools', primaryType: 'text', capabilities: ['function_calling'] },
      ],
    }]} value={null} onSelect={onSelect} trigger={trigger} />);
    await userEvent.click(screen.getByRole('button', { name: 'Choose model' }));
    await userEvent.type(searchBox(), 'reasoning');
    expect(screen.queryByRole('option', { name: 'plain' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'smart' })).toBeVisible();
    await userEvent.clear(searchBox());
    await userEvent.type(searchBox(), 'tools');
    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({ providerId: 'provider', model: 'tools' });
  });

  it('moves across provider groups and supports page navigation from the search input', async () => {
    const onSelect = vi.fn();
    render(<ModelPicker providers={[
      { id: 'first', name: 'First', models: ['one'] },
      { id: 'second', name: 'Second', models: ['two', 'three'] },
    ]} value={{ providerId: 'first', model: 'one' }} onSelect={onSelect} trigger={trigger} />);
    await userEvent.click(screen.getByRole('button', { name: 'Choose model' }));
    await userEvent.click(searchBox());
    await userEvent.keyboard('{PageDown}{ArrowUp}{Enter}');
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({ providerId: 'second', model: 'two' });
  });

  it('blocks both pointer and keyboard selection while saving, then allows retry', async () => {
    const onSelect = vi.fn();
    const props = { providers, value: null, onSelect, trigger, closeOnSelect: false };
    const { rerender } = render(<ModelPicker {...props} pending pendingValue={{ providerId: 'second', model: 'other-model' }} />);
    await userEvent.click(screen.getByRole('button', { name: 'Choose model' }));
    const option = screen.getByRole('option', { name: 'other-model' });
    expect(option).toBeDisabled();
    expect(option).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(option);
    await userEvent.click(searchBox());
    await userEvent.keyboard('{Enter}');
    expect(onSelect).not.toHaveBeenCalled();
    rerender(<ModelPicker {...props} error="Save failed" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Save failed');
    await userEvent.click(screen.getByRole('option', { name: 'other-model' }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({ providerId: 'second', model: 'other-model' });
    expect(screen.getByRole('button', { name: 'Choose model' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('reveals complete long names and known prices in delayed hover details', async () => {
    const model = 'a-model-name-that-is-long-enough-to-truncate-in-the-picker';
    render(<ModelPicker providers={[{ id: 'provider', name: 'Provider', models: [model],
      modelRecords: [{ modelId: model, primaryType: 'text', cost: { input: 0, output: 0.125 } }],
    }]} value={null} onSelect={vi.fn()} trigger={trigger} />);
    await userEvent.click(screen.getByRole('button', { name: 'Choose model' }));
    await userEvent.hover(screen.getByRole('option', { name: model }));
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    const card = await screen.findByRole('complementary', { name: model }, { timeout: 2500 });
    expect(within(card).getAllByText(model)).toHaveLength(2);
    expect(within(card).getByText('0 $/M')).toBeVisible();
    expect(within(card).getByText('0.125 $/M')).toBeVisible();
    await userEvent.hover(card);
    expect(card).toBeVisible();
    await userEvent.type(searchBox(), 'missing');
    await waitFor(() => expect(screen.queryByRole('complementary')).not.toBeInTheDocument());
  });

  it('omits missing or invalid rates without hiding a valid zero output price', async () => {
    render(<ModelPicker providers={[{ id: 'provider', name: 'Provider', models: ['unknown', 'output-only'],
      modelRecords: [{ modelId: 'output-only', primaryType: 'text', cost: { input: -1, output: 0 } }],
    }]} value={null} onSelect={vi.fn()} trigger={trigger} />);
    await userEvent.click(screen.getByRole('button', { name: 'Choose model' }));
    expect(screen.getByRole('option', { name: 'unknown' })).not.toHaveTextContent('$');
    const output = screen.getByRole('option', { name: 'output-only' });
    expect(output).toHaveTextContent('0$↑');
    expect(output).not.toHaveTextContent('↓');
  });

  it('dismisses with Escape and returns focus to the model trigger', async () => {
    render(<ModelPicker providers={providers} value={null} onSelect={vi.fn()} trigger={trigger} />);
    const button = screen.getByRole('button', { name: 'Choose model' });
    await userEvent.click(button);
    await userEvent.click(searchBox());
    await userEvent.keyboard('{Escape}');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveFocus();
  });
});
