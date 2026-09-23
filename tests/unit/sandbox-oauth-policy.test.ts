// @vitest-environment node
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  sandboxAuthorizationMetadata, sandboxProtectedResourceMetadata, sandboxAuthChallenge,
  sandboxMcpResource, sandboxIdFromResource, sandboxPublicOrigin, parseSandboxScopes,
  pkceMatches, isValidOAuthRedirect, exactParameter, toolsForSandboxScopes, sandboxToolAnnotations,
} from '@/lib/sandboxes/oauth-policy';
afterEach(() => vi.unstubAllEnvs());
describe('ChatGPT sandbox OAuth protocol policy', () => {
  it('publishes consistent issuer, audience, PKCE, DCR and refresh discovery', () => {
    vi.stubEnv('TOOLPLANE_PUBLIC_URL', 'https://toolplane.test');
    const resource = sandboxMcpResource('sb-1');
    const as = sandboxAuthorizationMetadata(); const prm = sandboxProtectedResourceMetadata('sb-1');
    expect(prm.resource).toBe(resource); expect(prm.authorization_servers).toEqual([as.issuer]);
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.grant_types_supported).toContain('refresh_token');
    expect(as.scopes_supported).toContain('offline_access');
    expect(as.authorization_response_iss_parameter_supported).toBe(true);
    expect(sandboxAuthChallenge('sb-1')).toContain('/.well-known/oauth-protected-resource/api/v1/sandboxes/sb-1/mcp');
  });
  it('never normalizes an untrusted audience into the configured resource', () => {
    vi.stubEnv('TOOLPLANE_PUBLIC_URL', 'https://toolplane.test');
    expect(sandboxIdFromResource(sandboxMcpResource('one'))).toBe('one');
    for (const url of ['https://evil.test/api/v1/sandboxes/one/mcp', 'https://toolplane.test/api/v1/sandboxes/one/mcp/', 'https://toolplane.test/api/v1/sandboxes/one/mcp?x=1', 'https://toolplane.test/api/v1/sandboxes/%6fne/mcp']) expect(sandboxIdFromResource(url)).toBeNull();
    expect(() => sandboxAuthChallenge('bad"\nheader')).toThrow();
  });
  it('rejects non-HTTPS production origins and paths; permits loopback development', () => {
    for (const origin of ['http://toolplane.test', 'https://user:pass@toolplane.test', 'https://toolplane.test/path']) {
      vi.stubEnv('TOOLPLANE_PUBLIC_URL', origin); expect(() => sandboxPublicOrigin()).toThrow();
    }
    vi.stubEnv('TOOLPLANE_PUBLIC_URL', 'http://localhost:3000'); expect(sandboxPublicOrigin()).toBe('http://localhost:3000');
  });
  it('validates S256 proofs and rejects downgrade/short verifiers', () => {
    const verifier = 'v'.repeat(64); const challenge = createHash('sha256').update(verifier).digest('base64url');
    expect(pkceMatches(verifier, challenge)).toBe(true); expect(pkceMatches('w'.repeat(64), challenge)).toBe(false);
    expect(pkceMatches('v', challenge)).toBe(false); expect(pkceMatches(verifier, verifier)).toBe(false);
  });
  it('accepts exact ChatGPT callback registration without permitting insecure redirects', () => {
    expect(isValidOAuthRedirect('https://chatgpt.com/connector_platform_oauth_redirect')).toBe(true);
    expect(isValidOAuthRedirect('https://chatgpt.com/connector/oauth/unique-client')).toBe(true);
    for (const uri of ['javascript:alert(1)', 'http://evil.test/cb', 'https://x.test/cb#secret', 'https://u:p@x.test/cb']) expect(isValidOAuthRedirect(uri)).toBe(false);
  });
  it('defaults to read-only plus refresh; never maps unknown scopes to execution', () => {
    const scopes = parseSandboxScopes(null); expect(scopes).toEqual(['sandbox:read', 'offline_access']);
    expect(toolsForSandboxScopes(scopes)).not.toContain('shell_exec');
    expect(() => parseSandboxScopes('admin')).toThrow(); expect(() => parseSandboxScopes('')).toThrow();
    expect(sandboxToolAnnotations('read_file').readOnlyHint).toBe(true);
    expect(sandboxToolAnnotations('shell_exec')).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  });
  it('rejects duplicated OAuth parameters instead of choosing first/last inconsistently', () => {
    expect(() => exactParameter(new URLSearchParams('resource=a&resource=b'), 'resource')).toThrow();
  });
});
