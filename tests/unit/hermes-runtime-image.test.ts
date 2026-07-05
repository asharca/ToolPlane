import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readRepoFile(file: string) {
  return readFileSync(path.join(process.cwd(), file), 'utf8');
}

describe('Hermes hosted runner image contract', () => {
  it('bundles a pinned Hermes checkout and runner venv in the app image', () => {
    const dockerfile = readRepoFile('Dockerfile');

    expect(dockerfile).toContain('ARG HERMES_REPO=https://github.com/NousResearch/hermes-agent.git');
    expect(dockerfile).toContain('ARG HERMES_REF=7e8f50a14176e02b514631b0b04470acaadae32a');
    expect(dockerfile).toContain('ARG HERMES_ARCHIVE_URL=');
    expect(dockerfile).toContain('FROM ${NODE_IMAGE} AS python-runtime-base');
    expect(dockerfile).toContain('FROM python-runtime-base AS hermes');
    expect(dockerfile).toContain('FROM python-runtime-base AS runtime');
    expect(dockerfile).toContain('Acquire::Retries "5";');
    expect(dockerfile).toContain('/archive/${HERMES_REF}.tar.gz');
    expect(dockerfile).toContain('/opt/hermes-agent');
    expect(dockerfile).toContain('/opt/toolplane-hermes-venv');
    expect(dockerfile).toContain('pip install ".[messaging,wecom,dingtalk]"');
    expect(dockerfile).toContain('ARG TOOLPLANE_VERSION=dev');
    expect(dockerfile).toContain('/app/.toolplane-version');
    expect(dockerfile).toContain('chown node:node /app');
  });

  it('runs the prebuilt app image and wires bundled Hermes runtime through Docker Compose', () => {
    const compose = readRepoFile('docker-compose.yml');

    expect(compose).not.toContain('build:\n      context: .');
    expect(compose).toContain('image: ${TOOLPLANE_IMAGE:-ghcr.io/asharca/toolplane:latest}');
    expect(compose).not.toContain('container_name: toolplane-app');
    expect(compose).toContain('VOLUMES: 1');
    expect(compose).toContain('EXEC: 1');
    expect(compose).toContain("- '${APP_HOST_PORT:-10030}:3000'");
    expect(compose).toContain('http://127.0.0.1:3000/api/v1/health');
    expect(compose).toContain('TOOLPLANE_IMAGE: ${TOOLPLANE_IMAGE:-ghcr.io/asharca/toolplane:latest}');
    expect(compose).toContain('TOOLPLANE_UPDATE_ENABLED: ${TOOLPLANE_UPDATE_ENABLED:-true}');
    expect(compose).toContain('TOOLPLANE_UPDATE_REPO: ${TOOLPLANE_UPDATE_REPO:-asharca/ToolPlane}');
    expect(compose).toContain('TOOLPLANE_UPDATE_ARTIFACT: ${TOOLPLANE_UPDATE_ARTIFACT:-toolplane-runtime-linux-amd64.tar.gz}');
    expect(compose).toContain('TOOLPLANE_RUNTIME_ROOT: /app');
    expect(compose).toContain('HERMES_ROOT: /opt/hermes-agent');
    expect(compose).toContain('TOOLPLANE_HERMES_ROOT: /opt/hermes-agent');
    expect(compose).toContain('TOOLPLANE_PYTHON: /opt/toolplane-hermes-venv/bin/python');
  });
});
