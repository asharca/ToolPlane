export const HERMES_RUNTIME_KIND = 'hermes';
export const HERMES_IMAGE_REPOSITORY = 'nousresearch/hermes-agent';
export const DEFAULT_HERMES_IMAGE = `${HERMES_IMAGE_REPOSITORY}:latest`;

// Kept intentionally small and pinned where possible. The Docker Hub tag list
// changes independently of ToolPlane releases, so users can still enter a
// newer official tag (or a trusted custom image) through the custom-image
// field. `latest` remains available for users who explicitly prefer mutable
// upgrades.
export const HERMES_IMAGE_OPTIONS = [
  DEFAULT_HERMES_IMAGE,
  `${HERMES_IMAGE_REPOSITORY}:v2026.8.3`,
  `${HERMES_IMAGE_REPOSITORY}:v2026.7.30`,
  `${HERMES_IMAGE_REPOSITORY}:v2026.7.20`,
  `${HERMES_IMAGE_REPOSITORY}:v2026.7.7.2`,
  `${HERMES_IMAGE_REPOSITORY}:v2026.7.7`,
  `${HERMES_IMAGE_REPOSITORY}:v2026.7.1`,
] as const;

const PUBLIC_HERMES_RELEASE_IMAGES = new Set<string>(HERMES_IMAGE_OPTIONS.filter((image) => (
  image !== DEFAULT_HERMES_IMAGE
)));

const DOCKER_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/@:+-]{0,254}$/;

/**
 * Docker image references are passed to the Docker CLI as a single argument.
 * Keep this deliberately stricter than Docker's full grammar so a forged form
 * cannot turn an image choice into a Docker CLI flag. The runtime still
 * supports trusted custom registries and tags.
 */
export function isValidHermesImage(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && DOCKER_IMAGE.test(value.trim());
}

/**
 * Public runtimes fail closed to images reviewed by this ToolPlane release.
 * Operators may add exact immutable digests through an explicit allowlist;
 * mutable `latest` and arbitrary per-Agent custom images never cross into the
 * untrusted public prompt boundary automatically.
 */
export function isPublicHermesImage(value: unknown): value is string {
  if (!isValidHermesImage(value)) return false;
  const image = value.trim();
  if (PUBLIC_HERMES_RELEASE_IMAGES.has(image)) return true;
  const configured = (process.env.TOOLPLANE_PUBLIC_HERMES_IMAGES ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return configured.includes(image) && /@sha256:[a-f0-9]{64}$/i.test(image);
}

/** Runtime revisions only execute an immutable digest, never a mutable tag. */
export function isPinnedPublicHermesImage(value: unknown): value is string {
  if (!isValidHermesImage(value)) return false;
  const image = value.trim();
  if (
    new RegExp(`^(?:docker\\.io/)?${HERMES_IMAGE_REPOSITORY.replace('/', '\\/')}@sha256:[a-f0-9]{64}$`, 'i')
      .test(image)
  ) return true;
  return (process.env.TOOLPLANE_PUBLIC_HERMES_IMAGES ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .includes(image)
    && /@sha256:[a-f0-9]{64}$/i.test(image);
}

export function resolveHermesImage(raw: unknown): string {
  const configured = process.env.TOOLPLANE_HERMES_IMAGE?.trim();
  const fallback = configured && isValidHermesImage(configured)
    ? configured
    : DEFAULT_HERMES_IMAGE;
  const value = String(raw ?? '').trim();
  return isValidHermesImage(value) ? value : fallback;
}

export function isHermesRuntimeKind(value: unknown): value is typeof HERMES_RUNTIME_KIND {
  return value === HERMES_RUNTIME_KIND;
}
