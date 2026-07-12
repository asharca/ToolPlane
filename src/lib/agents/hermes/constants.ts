export const HERMES_RUNTIME_KIND = 'hermes';
export const DEFAULT_HERMES_IMAGE = 'nousresearch/hermes-agent:latest';

const DOCKER_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/@:+-]{0,254}$/;

export function resolveHermesImage(raw: unknown): string {
  const configured = process.env.TOOLPLANE_HERMES_IMAGE?.trim();
  const fallback = configured && DOCKER_IMAGE.test(configured)
    ? configured
    : DEFAULT_HERMES_IMAGE;
  const value = String(raw ?? '').trim();
  return value && DOCKER_IMAGE.test(value) ? value : fallback;
}

export function isHermesRuntimeKind(value: unknown): value is typeof HERMES_RUNTIME_KIND {
  return value === HERMES_RUNTIME_KIND;
}
