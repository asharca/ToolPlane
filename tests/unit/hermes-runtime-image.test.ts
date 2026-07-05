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
  });

  it('wires the bundled Hermes runtime through Docker Compose', () => {
    const compose = readRepoFile('docker-compose.yml');

    expect(compose).toContain('HERMES_REPO: ${HERMES_REPO:-https://github.com/NousResearch/hermes-agent.git}');
    expect(compose).toContain('HERMES_REF: ${HERMES_REF:-7e8f50a14176e02b514631b0b04470acaadae32a}');
    expect(compose).toContain('HERMES_ARCHIVE_URL: ${HERMES_ARCHIVE_URL:-}');
    expect(compose).toContain('HERMES_ROOT: /opt/hermes-agent');
    expect(compose).toContain('TOOLPLANE_HERMES_ROOT: /opt/hermes-agent');
    expect(compose).toContain('TOOLPLANE_PYTHON: /opt/toolplane-hermes-venv/bin/python');
  });
});
