// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ObservationLimiter } from '@/lib/a2a/transport-limits';

describe('native A2A boundaries', () => {
  it.each(['model', 'store', 'handler', 'worker', 'executor', 'http'])('%s never calls legacy Responses/delegation execution', (name) => {
    const source = readFileSync(resolve('src/lib/a2a', `${name}.ts`), 'utf8');
    expect(source).not.toMatch(/from\s+['"][^'"]*(?:public-api\/runs|agents\/collaboration|agents\/run)['"]/);
    expect(source).not.toMatch(/\b(?:prepareAgentResponse|executePreparedAgentResponse|runAgentTurn)\s*\(/);
  });
  it('limits observer slots and returns them exactly once', () => {
    const limiter = new ObservationLimiter(1, 2);
    const releaseA = limiter.acquire('a'); const releaseB = limiter.acquire('b');
    expect(() => limiter.acquire('a')).toThrow(); expect(() => limiter.acquire('c')).toThrow();
    releaseA(); releaseA(); const releaseC = limiter.acquire('c');
    expect(() => limiter.acquire('d')).toThrow(); releaseB(); releaseC();
    expect(() => limiter.acquire('a')).not.toThrow();
  });
});
