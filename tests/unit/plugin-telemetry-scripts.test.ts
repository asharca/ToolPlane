import { describe, it, expect } from 'vitest';
import { buildSkillInvocationScript } from '@/lib/plugin/skill-invocation-script';
import { buildSyncScript } from '@/lib/plugin/sync-script';

const BASE = 'http://localhost:3000';

describe('buildSkillInvocationScript', () => {
  const script = buildSkillInvocationScript({
    apiBase: BASE,
    workspaceSlug: 'ws',
    toolkitSlug: 'tk',
    client: 'claude-code',
  });

  it('bakes the install-time values and targets the skill-invocation endpoint', () => {
    expect(script).toContain('API_BASE="http://localhost:3000"');
    expect(script).toContain('WORKSPACE="ws"');
    expect(script).toContain('TOOLKIT="tk"');
    expect(script).toContain('CLIENT="claude-code"');
    expect(script).toContain('"$API_BASE/api/v1/plugin/skill-invocation"');
  });

  it('only fires for the Skill tool and validates the slug', () => {
    expect(script).toContain('[ "$TOOL_NAME" = "Skill" ]');
    expect(script).toContain('^[a-z0-9][a-z0-9-]*[a-z0-9]$');
  });

  it('reads the Bearer token from the plugin .mcp.json', () => {
    expect(script).toContain('MCP_CONFIG="$PLUGIN_ROOT/.mcp.json"');
    expect(script).toContain('Authorization');
  });

  it('attributes source via invocation_trigger (no bash ${...} that would break String.raw)', () => {
    expect(script).toContain('user-slash');
    // The emitted bash must use plain $VAR — a bash ${...} would have been
    // interpolated away by the String.raw template at build time.
    expect(script).not.toMatch(/\$\{[A-Z]/);
  });
});

describe('buildSyncScript telemetry', () => {
  const sync = buildSyncScript({
    apiBase: BASE,
    workspaceSlug: 'ws',
    toolkitSlug: 'tk',
    client: 'claude-code',
  });

  it('reports the delta to sync-applied and failures to sync-failure', () => {
    expect(sync).toContain('/api/v1/plugin/sync-applied');
    expect(sync).toContain('/api/v1/plugin/sync-failure');
    expect(sync).toContain('reason:"sync_failed"');
    expect(sync).toContain('retaining last known good skills');
    expect(sync).toContain('exit "$RESULT"');
  });

  it('counts added / updated / removed for the applied delta', () => {
    expect(sync).toContain('added');
    expect(sync).toContain('updated');
    expect(sync).toContain('removed');
    expect(sync).toContain('JSON.parse(process.env.COUNTS)');
    expect(sync).not.toContain('RESP_JSON=');

  });
});
