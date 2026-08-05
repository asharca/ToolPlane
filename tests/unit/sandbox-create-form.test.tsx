import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SandboxCreateForm } from '@/components/dashboard/sandboxes/SandboxCreateForm';

vi.mock('@/lib/sandboxes/actions', () => ({ createSandboxAction: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

class MockXmlHttpRequest extends EventTarget {
  static instances: MockXmlHttpRequest[] = [];

  status = 201;
  responseText = JSON.stringify({ agentId: 'agent-imported' });
  withCredentials = false;
  upload = new EventTarget();
  open = vi.fn();
  setRequestHeader = vi.fn();
  send = vi.fn(() => {
    queueMicrotask(() => {
      this.upload.dispatchEvent(new Event('load'));
      this.dispatchEvent(new Event('load'));
    });
  });

  constructor() {
    super();
    MockXmlHttpRequest.instances.push(this);
  }
}

afterEach(() => {
  MockXmlHttpRequest.instances = [];
  vi.unstubAllGlobals();
});

describe('SandboxCreateForm', () => {
  it('offers a safe .hermes ZIP import flow', async () => {
    render(<SandboxCreateForm workspace="acme" hermesArchiveMaxUploadMiB={17} />);

    await userEvent.click(screen.getByRole('button', { name: 'New sandbox' }));
    await userEvent.click(screen.getByRole('button', { name: /Import .hermes archive/ }));

    const archive = screen.getByLabelText('Hermes archive');
    expect(archive).toHaveAttribute('type', 'file');
    expect(archive).toHaveAttribute('accept', '.zip,application/zip');
    expect(screen.getByText(/up to 17 MiB/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).toBeRequired();
    expect(screen.getByText('What gets imported')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import and create Hermes sandbox' })).toBeInTheDocument();
    expect(document.querySelector('input[name="workspace"]')).toHaveValue('acme');
  });

  it('renders a 10 GiB configured limit in a human-readable form', async () => {
    render(<SandboxCreateForm workspace="acme" hermesArchiveMaxUploadMiB={10_240} />);

    await userEvent.click(screen.getByRole('button', { name: 'New sandbox' }));
    await userEvent.click(screen.getByRole('button', { name: /Import .hermes archive/ }));

    expect(screen.getByText(/up to 10 GiB \(10240 MiB\)/)).toBeInTheDocument();
  });

  it('sends a stable client import ID with the raw Hermes archive request', async () => {
    vi.stubGlobal('XMLHttpRequest', MockXmlHttpRequest);
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'import-request-0001') });
    const user = userEvent.setup();
    render(<SandboxCreateForm workspace="acme" />);

    await user.click(screen.getByRole('button', { name: 'New sandbox' }));
    await user.click(screen.getByRole('button', { name: /Import .hermes archive/ }));
    const archive = new File(['zip'], 'backup.zip', { type: 'application/zip' });
    await user.upload(screen.getByLabelText('Hermes archive'), archive);
    await user.click(screen.getByRole('checkbox'));
    fireEvent.submit(screen.getByRole('button', { name: 'Import and create Hermes sandbox' }).closest('form')!);

    await waitFor(() => expect(MockXmlHttpRequest.instances).toHaveLength(1));
    const request = MockXmlHttpRequest.instances[0];
    expect(request.setRequestHeader).toHaveBeenCalledWith(
      'x-toolplane-hermes-import-id',
      'import-request-0001',
    );
    expect(request.send).toHaveBeenCalledWith(archive);
  });
});
