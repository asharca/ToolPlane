// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  filterWorkArtifacts,
  requiresWorkApproval,
  scopeWorkToolArgs,
} from '@/lib/work/coordinator';

describe('Work coordinator policy', () => {
  it('requires approval for mutations but not reads or host completion', () => {
    expect(requiresWorkApproval('abc123__process_exec')).toBe(true);
    expect(requiresWorkApproval('send_email')).toBe(true);
    expect(requiresWorkApproval('abc123__github_create_issue_hash')).toBe(true);
    expect(requiresWorkApproval('agent_delegate')).toBe(true);
    expect(requiresWorkApproval('abc123__read_file')).toBe(false);
    expect(requiresWorkApproval('complete_work')).toBe(false);
  });

  it('keeps only sandbox-scoped artifact paths', () => {
    expect(filterWorkArtifacts([
      '/workspace/report.md',
      'dist/result.json',
      '/workspace/../../etc/passwd',
      '../secret',
      '/etc/passwd',
      '',
    ])).toEqual(['/workspace/report.md', '/workspace/dist/result.json']);
  });

  it('resolves sandbox tool paths from the selected working directory', () => {
    expect(scopeWorkToolArgs('shell_exec', { command: 'pwd' }, 'projects/app')).toEqual({
      command: 'pwd',
      cwd: 'projects/app',
    });
    expect(scopeWorkToolArgs('read_file', { path: 'README.md' }, 'projects/app')).toEqual({
      path: 'projects/app/README.md',
    });
    expect(scopeWorkToolArgs('read_file', { path: '/workspace/shared.txt' }, 'projects/app')).toEqual({
      path: 'shared.txt',
    });
    expect(scopeWorkToolArgs('read_file', { path: 'projects/app/README.md' }, 'projects/app')).toEqual({
      path: 'projects/app/README.md',
    });
  });
});
