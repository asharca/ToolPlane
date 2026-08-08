import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ db: {} }));

import {
  DEPLOYMENT_CONFIG_MOUNT_PATH,
  configVolumeName,
  deploymentConfigVolumeHelperArgs,
  isDeploymentConfigText,
  safeDeploymentConfigFilePath,
} from '@/lib/process/deployment-config-volume';

describe('deployment configuration volume helpers', () => {
  it('derives a deterministic Docker-safe volume name', () => {
    expect(configVolumeName('deployment/../with spaces')).toBe(
      'toolplane_mcp_config_deployment_.._with_spaces',
    );
    expect(configVolumeName('deployment/../with spaces')).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.-]+$/);
  });

  it('accepts arbitrary text-file extensions but rejects unsafe paths', () => {
    expect(safeDeploymentConfigFilePath('ssh-config')).toBe('ssh-config');
    expect(safeDeploymentConfigFilePath('.private.pem')).toBe('.private.pem');
    expect(safeDeploymentConfigFilePath('nested/ssh-config.any')).toBe('nested/ssh-config.any');

    for (const unsafe of ['/etc/passwd', '../ssh-config', 'nested/../ssh-config', 'a\\b', 'bad\0name']) {
      expect(safeDeploymentConfigFilePath(unsafe)).toBeNull();
    }
  });

  it('accepts plain Unicode text and rejects NUL or lossy UTF-8 writes', () => {
    expect(isDeploymentConfigText('password: 密码\n')).toBe(true);
    expect(isDeploymentConfigText('before\0after')).toBe(false);
    expect(isDeploymentConfigText('\uD800')).toBe(false);
  });

  it('builds a least-privilege, no-network volume helper without a bind mount', () => {
    const args = deploymentConfigVolumeHelperArgs('toolplane_mcp_config_dep1', 'toolplane-mcp-config-helper');

    expect(args).toEqual(expect.arrayContaining([
      'create',
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--mount',
      `type=volume,src=toolplane_mcp_config_dep1,dst=${DEPLOYMENT_CONFIG_MOUNT_PATH}`,
    ]));
    expect(args).not.toContain('-v');
    expect(args).not.toContain('--volume');
  });
});
