import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_HERMES_IMAGE,
  resolveHermesImage,
} from "@/lib/agents/hermes/constants";

describe("Historical Hermes image metadata", () => {
  it("accepts Docker image references and rejects argument-shaped values", () => {
    expect(resolveHermesImage("nousresearch/hermes-agent:v2026.6.5")).toBe(
      "nousresearch/hermes-agent:v2026.6.5",
    );
    expect(resolveHermesImage("--privileged")).toBe(DEFAULT_HERMES_IMAGE);
    expect(resolveHermesImage("image name")).toBe(DEFAULT_HERMES_IMAGE);
  });

  it("uses the configured instance image when an archive does not select one", () => {
    vi.stubEnv(
      "TOOLPLANE_HERMES_IMAGE",
      "registry.example/hermes-agent:stable",
    );
    expect(resolveHermesImage(undefined)).toBe(
      "registry.example/hermes-agent:stable",
    );
    expect(resolveHermesImage("--not-an-image")).toBe(
      "registry.example/hermes-agent:stable",
    );
    vi.unstubAllEnvs();
  });
});
