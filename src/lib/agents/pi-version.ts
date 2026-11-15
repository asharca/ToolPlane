/** Pi SDK installed in every Agent sandbox and written to new revisions, sessions and packages. */
export const PI_SDK_VERSION = "1.5.2";
/** Earlier pins whose revisions, sessions and package captures continue on PI_SDK_VERSION. */
export const LEGACY_PI_SDK_VERSIONS = ["0.87.1"] as const;
export const PI_SDK_VERSIONS = [
  PI_SDK_VERSION,
  ...LEGACY_PI_SDK_VERSIONS,
] as const;
/** Credential-free image that provides the pinned SDK for capture, preflight and installation. */
export const PI_PACKAGE_CAPTURE_IMAGE = `toolplane-pi-package-capture:${PI_SDK_VERSION}`;

export function isSupportedPiVersion(version: unknown): boolean {
  return (PI_SDK_VERSIONS as readonly unknown[]).includes(version);
}
