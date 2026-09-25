import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Button, Checkbox, Input, NativeSelect, Radio, SearchInput, Textarea } from '@/components/ui/Controls';
import { ConfirmSubmitButton, CopyButton } from '@/components/ui/Forms';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/Dialog';

// No UI or Motion mocks: exercise actual components and native DOM behavior.
describe('beUI platform native contracts', () => {
  it('keeps default library buttons inert and migrated intrinsic buttons submitting', async () => {
    const submit = vi.fn((event) => event.preventDefault());
    render(<form onSubmit={submit}><Button>Library</Button><Button nativeButton unstyled>Intrinsic</Button></form>);
    await userEvent.click(screen.getByText('Library')); expect(submit).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText('Intrinsic')); expect(submit).toHaveBeenCalledTimes(1);
  });
  it('does not submit a dynamic undefined library type, but does retain a native default', () => {
    const { rerender } = render(<Button type={undefined}>Action</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'button');
    rerender(<Button nativeButton type={undefined}>Action</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'submit');
  });
  it('retains real input events, external form association, refs and uncontrolled reset', async () => {
    const change = vi.fn(); const ref = createRef<HTMLInputElement>();
    render(<><form id="native-form" aria-label="Form" /><label htmlFor="query">Query</label><Input ref={ref} id="query" name="query" form="native-form" defaultValue="initial" onChange={change} /></>);
    const input = screen.getByRole('textbox');
    expect(ref.current).toBe(input);
    await userEvent.clear(input); await userEvent.type(input, 'changed');
    expect(change.mock.calls.at(-1)?.[0].target).toBe(input);
    const form = screen.getByRole('form') as HTMLFormElement;
    expect(new FormData(form).get('query')).toBe('changed');
    act(() => form.reset()); expect(input).toHaveValue('initial');
  });
  it('keeps controlled numeric input and textarea values editable', async () => {
    function Fields() {
      const [number, setNumber] = useState('3'); const [text, setText] = useState('before');
      return <><Input aria-label="Count" type="number" value={number} onChange={e => setNumber(e.currentTarget.value)} /><Textarea aria-label="Notes" value={text} onChange={e => setText(e.currentTarget.value)} /></>;
    }
    render(<Fields />);
    await userEvent.clear(screen.getByLabelText('Count')); await userEvent.type(screen.getByLabelText('Count'), '12');
    expect(screen.getByLabelText('Count')).toHaveValue(12);
    await userEvent.type(screen.getByLabelText('Notes'), ' after'); expect(screen.getByLabelText('Notes')).toHaveValue('before after');
  });
  it('keeps multiple selection, disabled options, optgroups and form reset', async () => {
    render(<form aria-label="Selection"><NativeSelect aria-label="Choices" name="choices" multiple defaultValue={['a']}><optgroup label="Group"><option value="a">A</option><option value="b">B</option><option value="c" disabled>C</option></optgroup></NativeSelect></form>);
    const select = screen.getByRole('listbox');
    await userEvent.selectOptions(select, ['b', 'c']);
    const form = screen.getByRole('form') as HTMLFormElement;
    expect(new FormData(form).getAll('choices')).toEqual(['a', 'b']);
    act(() => form.reset()); expect(new FormData(form).getAll('choices')).toEqual(['a']);
    expect(within(form).queryByRole('button')).not.toBeInTheDocument();
  });
  it('retains required validation and disabled controls exclusion from FormData', () => {
    render(<form aria-label="Required"><Input name="required" aria-label="Required field" required /><Input name="hidden" type="hidden" value="secret" /><Input name="disabled" disabled defaultValue="ignored" /><NativeSelect name="selection" required aria-label="Selection"><option value="">Choose</option><option value="a">A</option></NativeSelect></form>);
    const form = screen.getByRole('form') as HTMLFormElement;
    expect(form.checkValidity()).toBe(false); const data = new FormData(form);
    expect(data.get('hidden')).toBe('secret'); expect(data.has('disabled')).toBe(false);
  });
  it('keeps label activation, radio grouping, indeterminate refs and choice reset', async () => {
    const ref = createRef<HTMLInputElement>();
    render(<form aria-label="Choices"><label><Checkbox ref={ref} name="enabled" defaultChecked />Enabled</label><label><Radio name="mode" value="a" defaultChecked />One</label><label><Radio name="mode" value="b" />Two</label></form>);
    ref.current!.indeterminate = true; expect(ref.current!.indeterminate).toBe(true);
    await userEvent.click(screen.getByText('Enabled')); expect(ref.current).not.toBeChecked();
    await userEvent.click(screen.getByText('Two')); expect(screen.getByLabelText('Two')).toBeChecked(); expect(screen.getByLabelText('One')).not.toBeChecked();
    act(() => (screen.getByRole('form') as HTMLFormElement).reset()); expect(ref.current).toBeChecked(); expect(screen.getByLabelText('One')).toBeChecked();
  });
  it('does not wrap peer switch inputs or break their sibling selectors', () => {
    render(<label><Input type="checkbox" role="switch" aria-label="Active" className="peer sr-only" /><span data-testid="thumb" className="peer-checked:translate-x-4" /></label>);
    expect(screen.getByRole('switch').nextElementSibling).toBe(screen.getByTestId('thumb'));
  });
  it('blocks the child handler as well as navigation when an asChild action is disabled', async () => {
    const child = vi.fn(); const parent = vi.fn();
    render(<Button asChild disabled onClick={parent}><a href="#danger" onClick={child}>Delete</a></Button>);
    await userEvent.click(screen.getByRole('link', { name: 'Delete' }));
    expect(child).not.toHaveBeenCalled(); expect(parent).not.toHaveBeenCalled();
    expect(screen.getByRole('link')).toHaveAttribute('aria-disabled', 'true');
  });
  it('preserves native drag events rather than substituting Motion gestures', () => {
    const start = vi.fn(); const dataTransfer = { setData: vi.fn(), getData: vi.fn() };
    render(<Button draggable onDragStart={start}>Drag tab</Button>);
    fireEvent.dragStart(screen.getByRole('button'), { dataTransfer });
    expect(start).toHaveBeenCalledTimes(1); expect(start.mock.calls[0][0].dataTransfer).toBe(dataTransfer);
  });
  it('preserves file uploads as native uncontrolled inputs', async () => {
    render(<Input type="file" aria-label="Upload" name="file" />);
    const file = new File(['test'], 'a.txt', { type: 'text/plain' }); const input = screen.getByLabelText('Upload') as HTMLInputElement;
    await userEvent.upload(input, file); expect(input.files?.[0]).toBe(file);
  });
  it('never submits destructive actions before explicit confirmation and restores focus on cancel', async () => {
    const submit = vi.fn((e) => e.preventDefault());
    render(<form onSubmit={submit}><ConfirmSubmitButton triggerLabel="Delete" confirmLabel="Confirm deletion" cancelLabel="Keep" prompt="Are you sure?" /></form>);
    await userEvent.click(screen.getByText('Delete')); expect(submit).not.toHaveBeenCalled();
    expect(screen.getByText('Confirm deletion')).toHaveFocus();
    await userEvent.click(screen.getByText('Keep')); expect(screen.getByText('Delete')).toHaveFocus(); expect(submit).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText('Delete')); await userEvent.click(screen.getByText('Confirm deletion')); expect(submit).toHaveBeenCalledTimes(1);
  });
  it('returns focus to search input after clearing', async () => {
    function Search() { const [value, setValue] = useState('query'); return <SearchInput label="Search" value={value} onChange={e => setValue(e.currentTarget.value)} onClear={() => setValue('')} />; }
    render(<Search />); await userEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByRole('searchbox')).toHaveValue(''); expect(screen.getByRole('searchbox')).toHaveFocus();
  });
  it.each(['disabled', 'readOnly'] as const)('does not clear a %s search field', async (mode) => {
    const clear = vi.fn();
    render(<SearchInput label="Search" value="protected" onClear={clear} {...{ [mode]: true }} />);
    const button = screen.getByRole('button', { name: 'Clear search' });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(clear).not.toHaveBeenCalled();
    expect(screen.getByRole('searchbox')).toHaveValue('protected');
  });
  it('reports clipboard failure without leaking an exception or moving focus', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('denied'));
    render(<CopyButton text="token" />);
    const button = screen.getByRole('button', { name: 'Copy' }); await user.click(button);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy failed' })).toHaveFocus());
    expect(document.querySelector('textarea')).toBeNull();
  });
  it('retains dialog accessible names, keyboard dismissal and focus restoration', async () => {
    render(<Dialog><DialogTrigger asChild><Button>Open settings</Button></DialogTrigger><DialogContent><DialogTitle>Settings</DialogTitle><DialogDescription>Change configuration</DialogDescription><Input aria-label="Name" /><Button>Save</Button></DialogContent></Dialog>);
    await userEvent.click(screen.getByText('Open settings'));
    const dialog = await screen.findByRole('dialog', { name: 'Settings' }); expect(dialog).toHaveAccessibleDescription('Change configuration');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('Open settings')).toHaveFocus();
  });
});
