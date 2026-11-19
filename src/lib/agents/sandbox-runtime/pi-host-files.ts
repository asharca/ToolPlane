// Trusted sources shipped next to the Pi host. Source and sandbox paths are
// relative to scripts/ and to the private host directory, respectively.
export const PI_HOST_ENTRY = "pi-sdk-session.mjs";
export const PI_HOST_PACKAGE_VERIFIER = "pi-sdk-package-files.mjs";

export const PI_HOST_FILES = [
  PI_HOST_ENTRY,
  PI_HOST_PACKAGE_VERIFIER,
  "pi-sdk-install.mjs",
  "pi-sdk-capabilities.mjs",
  "pi-sdk-ui.mjs",
  "pi-desktop-tools.mjs",
  "pi-sdk-context.mjs",
  "native-session-paths.mjs",
  "pi-sdk-native-resources.mjs",
  "pi-sdk-advisor.mjs",
  // Loaded relative to generated pi-mcp.mjs by mcp_result_to_file.
  "a2a-sandbox-files.mjs",
] as const;
