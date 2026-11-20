// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as RuntimeOwnership from "@/lib/runtime/ownership-state";
import type * as GithubRegistry from "@/lib/plugins/github";

const head = vi.hoisted(() => ({ commits: [] as string[] }));
vi.mock("@/lib/runtime/ownership-state", async (original) => ({
  ...(await original<typeof RuntimeOwnership>()),
  runtimeIsReady: () => true,
  trackRuntimeOperation: <T>(operation: () => Promise<T>) => operation(),
}));
vi.mock("@/lib/plugins/github", async (original) => {
  const actual = await original<typeof GithubRegistry>();
  class GithubRegistryTransport {
    async assertAccess() {}
    async resolveCommit() {
      const next = head.commits.shift();
      if (!next) throw new Error("unexpected HEAD lookup");
      return next;
    }
    async index() {
      return { schemaVersion: 3, plugins: [] };
    }
    async unregisteredDirectories() {
      return [];
    }
  }
  return { ...actual, GithubRegistryTransport };
});

import { db } from "@/lib/db";
import { runPendingGithubResourceSyncJobs } from "@/lib/plugins/indexer";
import {
  enqueuePluginSourceSync,
  listPluginSources,
} from "@/lib/plugins/sources";

let userId: string;
let workspaceId: string;
let registryId: string;

beforeAll(async () => {
  const stamp = randomUUID();
  userId = (
    await db.user.create({
      data: { email: `plugin-sync-${stamp}@test.invalid`, passwordHash: "x" },
    })
  ).id;
  workspaceId = (
    await db.workspace.create({
      data: { slug: `plugin-sync-${stamp}`, name: "Sync", ownerId: userId },
    })
  ).id;
  registryId = (
    await db.githubResourceRegistry.create({
      data: {
        workspaceId,
        createdById: userId,
        name: "Fixture",
        repository: `acme/plugins-${stamp}`,
        visibility: "public",
      },
    })
  ).id;
});

afterAll(async () => {
  await db.workspace.deleteMany({ where: { id: workspaceId } });
  await db.user.deleteMany({ where: { id: userId } });
});

describe("plugin source sync feedback", () => {
  it("retries a sync whose HEAD moved, then stops after three consecutive moves", async () => {
    await enqueuePluginSourceSync(registryId);
    const scope = {
      id: workspaceId,
      actorUserId: userId,
    } as Parameters<typeof listPluginSources>[0];

    for (const attempt of [1, 2, 3]) {
      head.commits = ["a".repeat(40), "b".repeat(40)];
      expect(await runPendingGithubResourceSyncJobs()).toBe(1);
      const [source] = (await listPluginSources(scope)).filter(
        (item) => item.id === registryId,
      );
      expect(source.lastJob).toMatchObject({
        status: "failed",
        error: "registry_source_changed",
        retried: attempt < 3,
      });
      if (attempt < 3) {
        expect(source).toMatchObject({ status: "pending", error: null });
        expect(source.activeJob).toMatchObject({ status: "pending" });
      } else {
        expect(source).toMatchObject({
          status: "error",
          error: "registry_source_changed",
          activeJob: null,
        });
      }
    }

    // A stable HEAD succeeds and records an (empty) result summary.
    await enqueuePluginSourceSync(registryId);
    head.commits = ["c".repeat(40), "c".repeat(40)];
    expect(await runPendingGithubResourceSyncJobs()).toBe(1);
    const [source] = (await listPluginSources(scope)).filter(
      (item) => item.id === registryId,
    );
    expect(source).toMatchObject({
      status: "synced",
      error: null,
      activeJob: null,
      lastJob: {
        status: "succeeded",
        commit: "c".repeat(40),
        summary: {
          resourceCount: 0,
          added: [],
          updated: [],
          removed: [],
          unregistered: [],
        },
      },
    });
  });
});
