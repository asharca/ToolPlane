import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { A2AArtifactParts } from '@/components/dashboard/agents/A2AArtifactParts';
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('explicit safe Artifact downloads', () => {
  it('renders text and structured data as inert text, never HTML', () => {
    const { container } = render(<A2AArtifactParts name="result" parts={[{ text: '<img src=x onerror=alert(1)>' }, { data: { html: '<script>alert(1)</script>' } }]} />);
    expect(container.querySelector('img,script,iframe')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(container.textContent).toContain('"html"');
  });
  it('creates a bounded attachment only on explicit click, then revokes its object URL', () => {
    vi.useFakeTimers();
    const create = vi.fn((value: Blob) => { expect(value).toBeInstanceOf(Blob); return 'blob:test'; }); const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke });
    let filename = ''; let rel = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { filename = this.download; rel = this.rel; });
    render(<A2AArtifactParts name="../unsafe.html" parts={[{ raw: btoa('<script>alert(1)</script>'), mediaType: 'text/html' }]} />);
    expect(create).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: 'downloadArtifact' }));
    expect(create).toHaveBeenCalledTimes(1); expect(create.mock.calls[0][0]).toMatchObject({ type: 'application/octet-stream' });
    expect(filename).toBe('.._unsafe.html'); expect(rel).toBe('noopener');
    vi.advanceTimersByTime(1000); expect(revoke).toHaveBeenCalledWith('blob:test');
  });
  it('does not offer a download for malformed or oversized bytes', () => {
    render(<A2AArtifactParts name="file" parts={[{ raw: 'invalid!' }, { raw: 'YQ=='.repeat(32768) }]} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
