import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SandboxConsole } from '@/components/dashboard/sandboxes/SandboxConsole';

vi.mock('@/components/dashboard/ConversationMessage', () => ({
  AssistantMarkdown: ({ text }: { text: string }) => <div>{text}</div>,
}));

function rpcResponse(value: unknown) {
  return new Response(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: JSON.stringify(value) }] },
  }), { headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SandboxConsole files', () => {
  it('lazily expands and caches directory children', async () => {
    const listedPaths: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        params: { name: string; arguments: { path: string } };
      };
      expect(body.params.name).toBe('list_dir');
      const path = body.params.arguments.path;
      listedPaths.push(path);
      return rpcResponse(path === '.' ? {
        path: '.',
        entries: [
          { name: 'src', type: 'dir', size: null },
          { name: 'README.md', type: 'file', size: 7 },
        ],
      } : {
        path: 'src',
        entries: [{ name: 'index.ts', type: 'file', size: 12 }],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <SandboxConsole compact filesOnly deploymentId="deployment-1" running initialPath="." initialEntries={[]} />,
    );

    const src = await screen.findByRole('button', { name: /src/ });
    expect(listedPaths).toEqual(['.']);
    expect(src).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: /index\.ts/ })).not.toBeInTheDocument();

    fireEvent.click(src);
    expect(await screen.findByRole('button', { name: /index\.ts/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /src/ })).toHaveAttribute('aria-expanded', 'true');
    expect(listedPaths).toEqual(['.', 'src']);

    fireEvent.click(screen.getByRole('button', { name: /src/ }));
    expect(screen.queryByRole('button', { name: /index\.ts/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /src/ }));
    expect(await screen.findByRole('button', { name: /index\.ts/ })).toBeInTheDocument();
    expect(listedPaths).toEqual(['.', 'src']);
  });

  it('loads the directory and previews Markdown and images', async () => {
    const createObjectURL = vi.fn(() => 'blob:sandbox-preview');
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: { name: string } };
      if (body.params.name === 'list_dir') {
        return rpcResponse({
          path: '.',
          entries: [
            { name: 'README.md', type: 'file', size: 7 },
            { name: 'preview.png', type: 'file', size: 8 },
          ],
        });
      }
      if (body.params.name === 'read_file') {
        return rpcResponse({ path: 'README.md', content: '# Hello' });
      }
      return rpcResponse({ filename: 'preview.png', encoding: 'base64', content: 'iVBORw0KGgo=' });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <SandboxConsole
        compact
        filesOnly
        deploymentId="deployment-1"
        running
        initialPath="."
        initialEntries={[]}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /README\.md/ }));
    expect(await screen.findByText('# Hello')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: /preview\.png/ }));

    const image = await screen.findByRole('img', { name: 'preview.png' });
    expect(image).toHaveAttribute('src', 'blob:sandbox-preview');
    expect(createObjectURL).toHaveBeenCalledOnce();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });

  it('uploads files into the selected directory and refreshes it', async () => {
    const calls: { name: string; path: string; body?: BodyInit | null }[] = [];
    let srcListings = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('/files/upload')) {
        calls.push({
          name: 'upload_file',
          path: new URL(String(url)).searchParams.get('path') ?? '',
          body: init?.body,
        });
        return Response.json({ relativePath: 'src/notes.txt', size: 5 }, { status: 201 });
      }
      const body = JSON.parse(String(init?.body)) as {
        params: { name: string; arguments: { path: string } };
      };
      calls.push({ name: body.params.name, ...body.params.arguments });
      srcListings += 1;
      return rpcResponse({
        path: 'src',
        entries: srcListings === 1 ? [] : [{ name: 'notes.txt', type: 'file', size: 5 }],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <SandboxConsole
        compact
        filesOnly
        deploymentId="deployment-1"
        running
        initialPath="."
        initialEntries={[{ name: 'src', type: 'dir', size: null }]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /src/ }));
    await waitFor(() => expect(calls).toHaveLength(1));
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    const uploadInput = document.querySelector('input[type="file"]');
    expect(uploadInput).toBeInstanceOf(HTMLInputElement);
    fireEvent.change(uploadInput as HTMLInputElement, { target: { files: [file] } });

    expect(await screen.findByRole('button', { name: /notes\.txt/ })).toBeInTheDocument();
    expect(calls.slice(0, 2)).toEqual([
      { name: 'list_dir', path: 'src' },
      { name: 'upload_file', path: 'src/notes.txt', body: file },
    ]);
    expect(calls.at(2)).toEqual({ name: 'list_dir', path: 'src' });
  });
});
