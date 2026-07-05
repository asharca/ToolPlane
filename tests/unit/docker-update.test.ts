import { describe, expect, it } from 'vitest';
import {
  buildReplacementCreatePayload,
  parseRegistryImageRef,
  selectUpdateNetwork,
} from '@/lib/system/docker-update';

describe('Docker app update helpers', () => {
  it('parses registry image references with tags and digests', () => {
    expect(parseRegistryImageRef('ghcr.io/asharca/toolplane:latest')).toEqual({
      registry: 'ghcr.io',
      repository: 'asharca/toolplane',
      reference: 'latest',
    });
    expect(parseRegistryImageRef('ghcr.io/asharca/toolplane@sha256:abc')).toEqual({
      registry: 'ghcr.io',
      repository: 'asharca/toolplane',
      reference: 'sha256:abc',
    });
    expect(parseRegistryImageRef('node:24-bookworm')).toBeNull();
  });

  it('creates a replacement payload without pinning the old hostname or runtime IP', () => {
    const payload = buildReplacementCreatePayload(
      {
        Id: 'old-container',
        Name: '/toolplane-app',
        Image: 'sha256:old',
        Config: {
          Image: 'ghcr.io/asharca/toolplane:old',
          Hostname: 'old-hostname',
          Domainname: 'local',
          Env: ['NODE_ENV=production'],
          Labels: { 'com.docker.compose.service': 'app' },
        },
        HostConfig: {
          RestartPolicy: { Name: 'unless-stopped' },
          PortBindings: { '3000/tcp': [{ HostPort: '3002' }] },
        },
        NetworkSettings: {
          Networks: {
            toolplane_default: {
              Aliases: ['app', 'toolplane-app'],
              IPAMConfig: { IPv4Address: '172.18.0.9' },
              IPAddress: '172.18.0.4',
            },
          },
        },
      },
      'ghcr.io/asharca/toolplane:latest',
    );

    expect(payload.Image).toBe('ghcr.io/asharca/toolplane:latest');
    expect(payload.Hostname).toBeUndefined();
    expect(payload.Domainname).toBeUndefined();
    expect(payload.HostConfig).toEqual({
      RestartPolicy: { Name: 'unless-stopped' },
      PortBindings: { '3000/tcp': [{ HostPort: '3002' }] },
    });
    expect(JSON.stringify(payload)).not.toContain('172.18.0.4');
    expect(payload.NetworkingConfig).toEqual({
      EndpointsConfig: {
        toolplane_default: {
          Aliases: ['app', 'toolplane-app'],
          IPAMConfig: { IPv4Address: '172.18.0.9' },
        },
      },
    });
  });

  it('uses the first attached network for the update helper', () => {
    expect(
      selectUpdateNetwork({
        Id: 'old-container',
        Name: '/toolplane-app',
        Image: 'sha256:old',
        NetworkSettings: {
          Networks: {
            toolplane_default: {},
          },
        },
      }),
    ).toBe('toolplane_default');
  });
});
