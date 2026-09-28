import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FormSelect } from '@/components/ui/FormSelect';
import { FormCheckbox } from '@/components/ui/FormCheckbox';

const options = [{ value: '', label: 'Choose runtime' }, { value: 'pi', label: 'Pi' }, { value: 'hermes', label: 'Hermes' }];

describe('beUI form participation', () => {
  it('blocks incomplete required choices and submits only successful values from visible controls', async () => {
    const action = vi.fn();
    render(<form action={action}>
      <FormSelect name="runtime" label="Runtime" required defaultValue="" options={options} />
      <FormCheckbox name="consent" value="yes" label="Publish consent" required />
      <FormCheckbox name="excluded" value="private" label="Unavailable option" disabled defaultChecked />
      <button type="submit">Publish</button>
    </form>);
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(action).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('combobox', { name: 'Runtime' }));
    await userEvent.click(screen.getByRole('option', { name: 'Hermes' }));
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(action).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Publish consent' }));
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const data = action.mock.calls[0][0] as FormData;
    expect(Object.fromEntries(data)).toEqual({ runtime: 'hermes', consent: 'yes' });
  });

  it('resets uncontrolled choices to their initial values and respects a cancelled reset', async () => {
    let cancelReset = false;
    const { container } = render(<form onReset={(event) => { if (cancelReset) event.preventDefault(); }}>
      <FormSelect name="runtime" label="Runtime" defaultValue="pi" options={options} />
      <FormCheckbox name="enabled" value="yes" label="Enabled" defaultChecked />
      <button type="reset">Reset choices</button>
    </form>);
    const form = container.querySelector('form')!;
    await userEvent.click(screen.getByRole('combobox', { name: 'Runtime' }));
    await userEvent.click(screen.getByRole('option', { name: 'Hermes' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Enabled' }));
    cancelReset = true;
    await userEvent.click(screen.getByRole('button', { name: 'Reset choices' }));
    expect(Object.fromEntries(new FormData(form))).toEqual({ runtime: 'hermes' });
    cancelReset = false;
    await userEvent.click(screen.getByRole('button', { name: 'Reset choices' }));
    await waitFor(() => expect(Object.fromEntries(new FormData(form))).toEqual({ runtime: 'pi', enabled: 'yes' }));
    expect(screen.getByRole('checkbox', { name: 'Enabled' })).toBeChecked();
  });
});
