// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { LocalA2AGrant } from "@/lib/a2a/principal";
const mocks = vi.hoisted(() => ({ agent: vi.fn(), dependencies: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/agents/queries", () => ({ ORDINARY_AGENT_FILTER: {} }));
vi.mock("@/lib/a2a/principal", () => ({
  A2A_SCOPES: ["a2a:send", "a2a:read", "a2a:cancel"],
  isLocalGrant: (g: { kind: string }) => g.kind === "local",
}));
import { assertLocalGrant, localTarget } from "@/lib/a2a/local-policy";
const legacyAgent = {
  id: "legacy-agent",
  name: "Persisted Pi",
  runtimeKind: "pi",
  systemPrompt: "Keep existing context",
  model: "fixture-model",
  maxSteps: 10,
  disabledBuiltinTools: [],
  provider: {
    id: "provider",
    format: "openai",
    baseUrl: "https://model.example/v1",
    apiKey: "fixture-only",
  },
  sandboxes: [
    {
      sandboxId: "sandbox",
      sandbox: {
        workspaceId: "ws",
        kind: "docker",
        network: "bridge",
        image: "fixture",
        config: null,
      },
    },
  ],
  servers: [],
  skills: [],
  toolkits: [],
  subAgents: [],
};
// Frozen persisted grant JSON: targetBinding was calculated from the PRE-SDK agent projection.
// Do not replace it with createLocalRootGrant/localTarget: that would conceal old-grant invalidation.
const persistedGrant = `{"kind":"local","workspaceId":"ws","agentId":"legacy-agent","actorId":"actor","targetBinding":"5ffb91c360bb5a70e236791b74ce05eecd986859e0cdcf412451743885955698","ownerKey":"persisted-owner","expiresAt":4102444800000,"scopes":["a2a:send","a2a:read","a2a:cancel"],"maxConcurrent":4,"timeoutSeconds":840,"retentionDays":7,"ancestorTaskIds":[],"ancestorAgentIds":[]}`;
const tx = {
  agent: { findFirst: mocks.agent },
  workspace: { count: async () => 1 },
  user: { count: async () => 1 },
  $queryRaw: mocks.dependencies,
} as unknown as Prisma.TransactionClient;
const packages = [
  {
    marketInstallId: "b",
    releaseId: "release-b",
    release: { checksum: "b".repeat(64) },
  },
  {
    marketInstallId: "a",
    releaseId: "release-a",
    release: { checksum: "a".repeat(64) },
  },
];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.dependencies.mockResolvedValue([]);
});
describe("native grant package fingerprints", () => {
  it("accepts the frozen pre-SDK Pi grant with the new database projection", async () => {
    mocks.agent.mockResolvedValue({ ...legacyAgent, piPackages: packages });
    const grant = JSON.parse(persistedGrant) as LocalA2AGrant;
    expect((await localTarget(tx, "ws", "legacy-agent")).binding).toBe(
      grant.targetBinding,
    );
    await expect(assertLocalGrant(grant, tx)).resolves.toBeUndefined();
    mocks.agent.mockResolvedValue({
      ...legacyAgent,
      systemPrompt: "Revoked configuration",
      piPackages: [],
    });
    await expect(assertLocalGrant(grant, tx)).rejects.toThrow();
  });
  it("binds SDK grants to a stable sorted install, release and checksum set", async () => {
    mocks.agent.mockResolvedValue({
      ...legacyAgent,
      runtimeKind: "pi-sdk",
      piPackages: packages,
    });
    const binding = (await localTarget(tx, "ws", "legacy-agent")).binding;
    mocks.agent.mockResolvedValue({
      ...legacyAgent,
      runtimeKind: "pi-sdk",
      piPackages: [...packages].reverse(),
    });
    expect((await localTarget(tx, "ws", "legacy-agent")).binding).toBe(binding);
    const grant = {
      ...JSON.parse(persistedGrant),
      targetBinding: binding,
    } as LocalA2AGrant;
    for (const changed of [
      [],
      [{ ...packages[0], marketInstallId: "different" }, packages[1]],
      [{ ...packages[0], releaseId: "different" }, packages[1]],
      [{ ...packages[0], release: { checksum: "c".repeat(64) } }, packages[1]],
    ]) {
      mocks.agent.mockResolvedValue({
        ...legacyAgent,
        runtimeKind: "pi-sdk",
        piPackages: changed,
      });
      await expect(assertLocalGrant(grant, tx)).rejects.toThrow();
    }
  });
});
