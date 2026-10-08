import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BundledFiles } from '@/components/dashboard/FilePathTree';
import { RuntimeFileDraftsInput, type RuntimeFileDraft } from '@/components/dashboard/RuntimeFileDraftsInput';
import { RuntimeFilesEditor } from '@/components/dashboard/RuntimeFilesEditor';

const actions = vi.hoisted(() => ({ reveal: vi.fn() }));
vi.mock('@/lib/workspace/runtime-files-actions', () => ({
  revealDeploymentRuntimeFileAction: actions.reveal,
  deleteDeploymentRuntimeFileAction: vi.fn(),
  upsertDeploymentRuntimeFileAction: vi.fn(),
}));

describe('file tree consumers', () => {
  it('distinguishes identical basenames and previews untrusted bundle text literally', () => {
    render(<BundledFiles ariaLabel="Bundle" files={[
      { path: 'a/config.json', content: 'first configuration' },
      { path: 'b/config.json', content: '<script>bad()</script>', encoding: 'utf8' },
    ]} />);
    const files = screen.getAllByRole('treeitem', { name: 'config.json' });
    fireEvent.click(files[1]);
    expect(screen.getByText('b/config.json')).toBeInTheDocument();
    expect(screen.getByText('<script>bad()</script>')).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
    fireEvent.click(files[0]);
    expect(screen.getByText('first configuration')).toBeInTheDocument();
    expect(screen.queryByText('<script>bad()</script>')).not.toBeInTheDocument();
  });

  it('preserves draft edits across navigation, new folders, and removal', () => {
    function Drafts() {
      const [files, setFiles] = useState<RuntimeFileDraft[]>([
        { path: 'first.txt', content: 'first' },
        { path: 'second.txt', content: 'second' },
      ]);
      return <RuntimeFileDraftsInput value={files} onChange={setFiles} />;
    }
    render(<Drafts />);
    fireEvent.change(screen.getByLabelText('Text content'), { target: { value: 'edited first' } });
    fireEvent.change(screen.getByLabelText('Relative file path'), { target: { value: 'nested/first.txt' } });
    expect(screen.getByRole('treeitem', { name: 'nested' })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('treeitem', { name: 'second.txt' }));
    expect(screen.getByLabelText('Text content')).toHaveValue('second');
    fireEvent.click(screen.getByRole('treeitem', { name: 'first.txt' }));
    expect(screen.getByLabelText('Text content')).toHaveValue('edited first');
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.queryByRole('treeitem', { name: 'first.txt' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Text content')).toHaveValue('second');
    fireEvent.click(screen.getByRole('button', { name: 'Add file' }));
    expect(screen.getByLabelText('Text content')).toHaveValue('');
    fireEvent.click(screen.getByRole('treeitem', { name: 'second.txt' }));
    expect(screen.getByLabelText('Text content')).toHaveValue('second');
  });

  it('does not reveal runtime credentials on tree selection', async () => {
    actions.reveal.mockResolvedValue({ path: 'nested/secret.txt', content: 'private credential' });
    render(<RuntimeFilesEditor workspace="workspace-a" deploymentId="deployment-a" initialFiles={[
      { id: 'one', path: 'config.txt', size: 4, updatedAt: '2026-10-08T00:00:00Z' },
      { id: 'two', path: 'nested/secret.txt', size: 18, updatedAt: '2026-10-08T00:00:00Z' },
    ]} />);
    fireEvent.click(within(screen.getByRole('tree')).getByRole('treeitem', { name: 'secret.txt' }));
    expect(actions.reveal).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Text content')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reveal & edit' }));
    expect(await screen.findByLabelText('Text content')).toHaveValue('private credential');
    expect(actions.reveal).toHaveBeenCalledWith({ workspace: 'workspace-a', deploymentId: 'deployment-a', fileId: 'two' });
  });
});
