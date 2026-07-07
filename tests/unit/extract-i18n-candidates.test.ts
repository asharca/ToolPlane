import { describe, it, expect, vi } from 'vitest';
import { extractCandidatesFromFiles, extractCandidatesFromSource } from '../../scripts/extract-i18n-candidates';

describe('extractCandidatesFromSource', () => {
  it('extracts JSX text and relevant JSX string attributes', () => {
    const source = `
      export function Demo() {
        return (
          <div>
            <h1>Hello World</h1>
            <input placeholder="Search…" aria-label="Search" />
            <button title="Submit">Send</button>
            <span>{'literal'}</span>
          </div>
        );
      }
    `;
    const candidates = extractCandidatesFromSource('Demo.tsx', source);
    const texts = candidates.map((c) => c.text);
    expect(texts).toContain('Hello World');
    expect(texts).toContain('Search…');
    expect(texts).toContain('Search');
    expect(texts).toContain('Submit');
    expect(texts).toContain('Send');
    expect(texts).toContain('literal');
    expect(candidates).toHaveLength(6);
  });

  it('ignores className and purely symbolic text', () => {
    const source = `
      export function Demo() {
        return <div className="foo bar">·</div>;
      }
    `;
    const candidates = extractCandidatesFromSource('Demo.tsx', source);
    expect(candidates).toEqual([]);
  });

  it('extracts project-specific text props and still ignores URLs', () => {
    const source = `
      export function Demo() {
        return (
          <Card
            subtitle="Card subtitle"
            description="Card description"
            lead="Leading text"
            tail="Trailing text"
            prompt="Prompt text"
            savedLabel="Saved"
            href="/ignored-url"
            src="/ignored-image.png"
          />
        );
      }
    `;
    const candidates = extractCandidatesFromSource('Demo.tsx', source);
    const attrNames = candidates.map((c) => c.attrName);
    expect(attrNames).toContain('subtitle');
    expect(attrNames).toContain('description');
    expect(attrNames).toContain('lead');
    expect(attrNames).toContain('tail');
    expect(attrNames).toContain('prompt');
    expect(attrNames).toContain('savedLabel');
    expect(attrNames).not.toContain('href');
    expect(attrNames).not.toContain('src');
  });

  it('extracts strings from conditional and template JSX expressions', () => {
    const source = `
      export function Demo({ show }: { show: boolean }) {
        return (
          <div>
            <span>{show ? 'Yes' : 'No'}</span>
            <span>{\`template\`}</span>
          </div>
        );
      }
    `;
    const candidates = extractCandidatesFromSource('Demo.tsx', source);
    const texts = candidates.map((c) => c.text);
    expect(texts).toContain('Yes');
    expect(texts).toContain('No');
    expect(texts).toContain('template');
    expect(candidates).toHaveLength(3);
  });

  it('does not extract existing translation calls', () => {
    const source = `
      export function Demo() {
        return <div>{t('mcpServers')}</div>;
      }
    `;
    const candidates = extractCandidatesFromSource('Demo.tsx', source);
    const texts = candidates.map((c) => c.text);
    expect(texts).not.toContain('mcpServers');
    expect(candidates).toEqual([]);
  });

  it('does not extract className helpers', () => {
    const source = `
      export function Demo() {
        return <div className={cn('foo', 'bar')}>Hello</div>;
      }
    `;
    const candidates = extractCandidatesFromSource('Demo.tsx', source);
    const texts = candidates.map((c) => c.text);
    expect(texts).not.toContain('foo');
    expect(texts).not.toContain('bar');
    expect(texts).toContain('Hello');
  });

  it('does not extract non-text props', () => {
    const source = `
      export function Demo() {
        return <Button variant="outline" size="sm" />;
      }
    `;
    const candidates = extractCandidatesFromSource('Demo.tsx', source);
    const texts = candidates.map((c) => c.text);
    expect(texts).not.toContain('outline');
    expect(texts).not.toContain('sm');
  });

  it('does not extract className from nested JSX in conditionals', () => {
    const source = `
      export function Demo({ badge }: { badge: boolean }) {
        return (
          <div>
            {badge ? <span className="x">Text</span> : null}
          </div>
        );
      }
    `;
    const candidates = extractCandidatesFromSource('Demo.tsx', source);
    const texts = candidates.map((c) => c.text);
    const attrNames = candidates.map((c) => c.attrName);
    expect(texts).toContain('Text');
    expect(texts).not.toContain('x');
    expect(attrNames).not.toContain('className');
  });

  it('extracts strings from logical && expressions', () => {
    const source = `export default () => <div>{show && 'Show me'}</div>;`;
    const candidates = extractCandidatesFromSource('Demo.tsx', source);
    expect(candidates.map((c) => c.text)).toContain('Show me');
  });

  it('extracts candidates from multiple files', () => {
    const files = ['a.tsx', 'b.tsx'];
    const readFile = (file: string) => {
      if (file === 'a.tsx') return `export default () => <div>Alpha</div>;`;
      if (file === 'b.tsx') return `export default () => <div>Beta</div>;`;
      return undefined;
    };
    const candidates = extractCandidatesFromFiles(files, readFile);
    const texts = candidates.map((c) => c.text);
    expect(texts).toContain('Alpha');
    expect(texts).toContain('Beta');
  });

  it('warns and skips unreadable files', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const candidates = extractCandidatesFromFiles(['missing.tsx'], () => undefined);
    expect(candidates).toEqual([]);
    expect(consoleWarn).toHaveBeenCalledWith('Warning: could not read file missing.tsx');
    consoleWarn.mockRestore();
  });
});
