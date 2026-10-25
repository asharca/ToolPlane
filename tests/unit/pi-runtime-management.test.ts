import { expect, it } from "vitest";
import { PI_SDK_RUNTIME } from "@/lib/agents/sandbox-runtime";
import { AgentEnvironmentSnapshotSchema } from "@/lib/agents/revision-types";
const environment = {
  kind: "docker",
  image: `toolplane-pi-package-capture@sha256:${"a".repeat(64)}`,
  network: "isolated",
  piVersion: "0.87.1",
  initialSnapshot: null,
  resourceLimits: { memoryBytes: 536870912, cpus: 1, pidsLimit: 128 },
  credentialReferences: [],
};

it("uses one fixed native SDK package set without install scripts or build approvals", () => {
  expect(PI_SDK_RUNTIME).toEqual({
    specs: [
      "@earendil-works/pi-coding-agent@0.87.1",
      "@earendil-works/pi-ai@0.87.1",
    ],
    directory: "/workspace/.toolplane/runtime-packages/pi-sdk-0.87.1",
    binary: "pi",
    ignoreScripts: true,
    allowBuilds: [],
  });
});

it.each(["latest", "^0.87.1", "0.87", "0.87.1;id", "../0.87.1"])(
  "rejects non-exact runtime version input %s",
  (version) => {
    expect(
      AgentEnvironmentSnapshotSchema.safeParse({
        ...environment,
        piVersion: version,
      }).success,
    ).toBe(false);
  },
);

it("requires an immutable environment image rather than a floating runtime installation", () => {
  expect(AgentEnvironmentSnapshotSchema.safeParse(environment).success).toBe(
    true,
  );
  expect(
    AgentEnvironmentSnapshotSchema.safeParse({
      ...environment,
      image: "toolplane-pi-package-capture:latest",
    }).success,
  ).toBe(false);
});
