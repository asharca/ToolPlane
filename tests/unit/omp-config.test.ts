import { describe, expect, it } from "vitest";
import {
  emptyOmpConfig,
  OmpConfigSnapshotSchema,
} from "@/lib/agents/omp-config";

describe("OMP private configuration boundary", () => {
  it("keeps display and execution preferences without accepting model or credential routing", () => {
    const base = emptyOmpConfig();
    expect(
      OmpConfigSnapshotSchema.parse({
        ...base,
        settings: {
          "display.showTokenUsage": true,
          "tools.outputMaxColumns": 768,
          "task.prewalk": false,
        },
      }).settings,
    ).toEqual({
      "display.showTokenUsage": true,
      "tools.outputMaxColumns": 768,
      "task.prewalk": false,
    });
    for (const settings of [
      { modelRoles: { default: "local/model" } },
      { task: { agentModelOverrides: { backend: "local/model" } } },
      { "retry.fallbackChains": ["local/model"] },
      { "service.accessToken": "private" },
      { "browser.relay": true },
      { mcp: { servers: { private: { command: "local-only" } } } },
    ])
      expect(
        OmpConfigSnapshotSchema.safeParse({ ...base, settings }).success,
      ).toBe(false);
  });

  it("rejects escaping, private-state and duplicate resource paths", () => {
    const base = emptyOmpConfig();
    for (const path of [
      "../models.yml",
      "/tmp/hook.ts",
      "hooks/../../auth.json",
      "skills/a/.env",
      "skills/a/cache.db",
      "agents\\escape.md",
      "models.yml",
    ]) {
      expect(
        OmpConfigSnapshotSchema.safeParse({
          ...base,
          files: [{ path, content: "data" }],
        }).success,
      ).toBe(false);
    }
    const resource = {
      path: "agents/backend.md",
      content: "---\nname: backend\n---\nImplement the backend.",
    };
    expect(
      OmpConfigSnapshotSchema.safeParse({
        ...base,
        files: [resource, resource],
      }).success,
    ).toBe(false);
    expect(
      OmpConfigSnapshotSchema.parse({ ...base, files: [resource] }).files,
    ).toEqual([resource]);
    expect(
      OmpConfigSnapshotSchema.safeParse({
        ...base,
        files: [
          {
            ...resource,
            content: "---\nname: backend\nmodel: local/model\n---\nImplement.",
          },
        ],
      }).success,
    ).toBe(false);
  });
});
