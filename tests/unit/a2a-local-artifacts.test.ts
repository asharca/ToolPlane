// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { Artifact } from '@a2a-js/sdk';
import { parseLocalArtifact } from '@/lib/a2a/local-artifacts';
const input = (part: unknown, name = 'report.txt') => ({ artifactId: 'report-1', name, parts: [part] });
describe('bounded standard A2A Artifact validation', () => {
  it('uses official data/raw/text Part encodings', () => {
    expect(Artifact.toJSON(parseLocalArtifact(input({ data: { ok: true } })))).toMatchObject({ parts: [{ data: { ok: true }, mediaType: 'application/json' }] });
    expect(Artifact.toJSON(parseLocalArtifact(input({ raw: 'aGVsbG8=', mediaType: 'application/octet-stream' })))).toMatchObject({ parts: [{ raw: 'aGVsbG8=' }] });
  });
  it.each([{ url: 'http://169.254.169.254/latest/meta-data' }, { file: { uri: '/etc/passwd' } }, { text: 'x', data: {} }, { raw: 'invalid!', mediaType: 'text/plain' }, { raw: 'Zh==', mediaType: 'text/plain' }, { raw: 'Zg==' }])('rejects unsafe or noncanonical content %j', (part) => {
    expect(() => parseLocalArtifact(input(part))).toThrow();
  });
  it.each(['../private', '/etc/passwd', 'a\\b', 'name\r\n'])('rejects path/header-like names %j', (name) => {
    expect(() => parseLocalArtifact(input({ text: 'hello' }, name))).toThrow();
  });
  it('counts UTF-8 bytes and decoded file sizes, not just code units', () => {
    expect(() => parseLocalArtifact(input({ text: '中'.repeat(12000) }))).toThrow();
    expect(() => parseLocalArtifact(input({ raw: Buffer.alloc(32769).toString('base64'), mediaType: 'application/octet-stream' }))).toThrow();
  });
});
