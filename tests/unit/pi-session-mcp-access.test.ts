import { createHash } from "node:crypto";
import { recoverPiSdkPackageReferences } from "@/lib/agents/sandbox-runtime";
import { expect, it } from "vitest";
import { assertPiSessionMcpAccess } from "@/lib/agents/pi-package-mcp";

it("pins original bindings without retaining revoked or redirected permissions", () => {
  const requirements = [{ key: "search", name: "Search", tools: ["lookup"] }];
  const original = {
    mcpBindings: { search: { deploymentId: "shared", tools: ["lookup"] } },
  };
  expect(assertPiSessionMcpAccess(requirements, original, original)).toEqual({
    shared: ["lookup"],
  });
  expect(() => assertPiSessionMcpAccess(requirements, original, {})).toThrow(
    "PI_PACKAGE_MCP_BINDING_REQUIRED",
  );
  expect(() =>
    assertPiSessionMcpAccess(requirements, original, {
      mcpBindings: {
        search: { deploymentId: "replacement", tools: ["lookup"] },
      },
    }),
  ).toThrow("PI_PACKAGE_MCP_BINDING_REQUIRED");
  expect(() =>
    assertPiSessionMcpAccess(requirements, original, {
      mcpBindings: { search: { deploymentId: "shared", tools: [] } },
    }),
  ).toThrow("PI_PACKAGE_MCP_BINDING_REQUIRED");
});

it("recovers only exact checksum-matching legacy references, never changed defaults", () => {
  const original = [
    { marketInstallId: "install", releaseId: "v1", checksum: "a".repeat(64) },
  ];
  const packageSetChecksum = createHash("sha256")
    .update(JSON.stringify(original))
    .digest("hex");
  expect(
    recoverPiSdkPackageReferences({ packageSetChecksum, packages: original }),
  ).toEqual(original);
  expect(() =>
    recoverPiSdkPackageReferences({
      packageSetChecksum,
      packages: [{ ...original[0], releaseId: "v2" }],
    }),
  ).toThrow("PI_SDK_LEGACY_RECOVERY_REQUIRED");
  expect(() => recoverPiSdkPackageReferences({ packageSetChecksum })).toThrow(
    "PI_SDK_LEGACY_RECOVERY_REQUIRED",
  );
});
