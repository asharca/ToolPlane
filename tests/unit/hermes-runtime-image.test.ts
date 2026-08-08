import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readRepoFile(file: string) {
  return readFileSync(path.join(process.cwd(), file), 'utf8');
}

describe('Hermes hosted runner image contract', () => {
  it('bundles a pinned Hermes checkout and runner venv in the app image', () => {
    const dockerfile = readRepoFile('Dockerfile');
    const runtimeAssembler = readRepoFile('scripts/assemble-runtime.mjs');

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
    expect(dockerfile).toContain('/app/dist/release/app/');
    expect(runtimeAssembler).toContain("path.join(outputRoot, '.toolplane-version')");
    expect(dockerfile).toContain('chown -R node:node /app /var/lib/toolplane');
  });

  it('runs the prebuilt app image and wires bundled Hermes runtime through Docker Compose', () => {
    const compose = readRepoFile('docker-compose.yml');

    expect(compose).not.toContain('build:\n      context: .');
    expect(compose).toContain('image: ${TOOLPLANE_IMAGE:-ghcr.io/asharca/toolplane:latest}');
    expect(compose).not.toContain('container_name: toolplane-app');
    expect(compose).toContain('hostname: toolplane-app');
    expect(compose).toContain('VOLUMES: 1');
    expect(compose).toContain('EXEC: 1');
    expect(compose).toContain("expose:");
    expect(compose).toContain("- '3000'");
    expect(compose).toContain("- '9321'");
    expect(compose).toContain('ports:');
    expect(compose).toContain("- '${APP_HOST_BIND:-0.0.0.0}:${APP_HOST_PORT:-10030}:3000'");
    expect(compose).toContain("- '${CONNECTOR_WS_HOST_BIND:-0.0.0.0}:${CONNECTOR_WS_HOST_PORT:-9321}:9321'");
    expect(compose).toContain('http://127.0.0.1:3000/api/v1/health');
    expect(compose).toContain('TOOLPLANE_IMAGE: ${TOOLPLANE_IMAGE:-ghcr.io/asharca/toolplane:latest}');
    expect(compose).toContain('TOOLPLANE_UPDATE_ENABLED: ${TOOLPLANE_UPDATE_ENABLED:-true}');
    expect(compose).toContain('TOOLPLANE_UPDATE_REPO: ${TOOLPLANE_UPDATE_REPO:-asharca/ToolPlane}');
    expect(compose).toContain('TOOLPLANE_UPDATE_ARTIFACT: ${TOOLPLANE_UPDATE_ARTIFACT:-toolplane-runtime-linux-amd64.tar.gz}');
    expect(compose).toContain('TOOLPLANE_RUNTIME_ROOT: /app');
    expect(compose).toContain('HERMES_ROOT: /opt/hermes-agent');
    expect(compose).toContain('TOOLPLANE_HERMES_ROOT: /opt/hermes-agent');
    expect(compose).toContain('TOOLPLANE_PYTHON: /opt/toolplane-hermes-venv/bin/python');
    expect(compose).toContain('${TOOLPLANE_HERMES_ARCHIVE_VOLUME:-toolplane_imports}:/var/lib/toolplane/imports');
    expect(compose).toContain('TOOLPLANE_HERMES_ARCHIVE_TMP_DIR: /var/lib/toolplane/imports');
    expect(compose).toContain('TOOLPLANE_HTTP_REQUEST_TIMEOUT_MS: ${TOOLPLANE_HTTP_REQUEST_TIMEOUT_MS:-14400000}');
    expect(compose).toContain('TOOLPLANE_MCP_STARTUP_IDLE_TIMEOUT_MS: ${TOOLPLANE_MCP_STARTUP_IDLE_TIMEOUT_MS:-300000}');
    expect(compose).toContain('TOOLPLANE_MCP_STARTUP_MAX_TIMEOUT_MS: ${TOOLPLANE_MCP_STARTUP_MAX_TIMEOUT_MS:-900000}');
  });

  it('labels and gives long cleanup time to the temporary container used for an archive import', () => {
    const runtime = readRepoFile('src/lib/agents/hermes/runtime.ts');

    expect(runtime).toContain("'--label', 'toolplane.hermes-archive-import=true'");
    expect(runtime).toContain('HERMES_ARCHIVE_COPY_TIMEOUT_MS,\n  ).catch(() => undefined);');
  });
});
