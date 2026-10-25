// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { LocalA2AGrant } from "@/lib/a2a/principal";

const mocks = vi.hoisted(() => ({ agent: vi.fn(), revision: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/agents/queries", () => ({ ORDINARY_AGENT_FILTER: {} }));
vi.mock("@/lib/agents/revisions", () => ({
  requireAgentRevision: mocks.revision,
}));
vi.mock("@/lib/a2a/principal", () => ({
  A2A_SCOPES: ["a2a:send", "a2a:read", "a2a:cancel"],
  isLocalGrant: (grant: { kind: string }) => grant.kind === "local",
}));
import { assertLocalGrant, localTarget } from "@/lib/a2a/local-policy";

const agent = {
  id: "agent",
  name: "Pinned Pi",
  runtimeKind: "pi-sdk",
  providerId: "provider",
  a2aInboundEnabled: true,
  a2aOutboundEnabled: true,
  modelProviders: [],
  sandboxes: [
    {
      sandboxId: "sandbox",
      sandbox: { workspaceId: "ws", kind: "docker", network: "isolated" },
    },
  ],
  skills: [{ installedSkillId: "skill" }],
  subAgents: [{ childId: "child" }],
};
const config = {
  sandboxTemplateId: "sandbox",
  providerId: "provider",
  model: "frozen-model",
  skills: [{ installedSkillId: "skill" }],
  a2a: {
    inboundEnabled: true,
    outboundEnabled: true,
    policy: { targets: [{ kind: "local", targetId: "child" }] },
  },
};
const tx = {
  agent: { findFirst: mocks.agent },
  workspace: { count: async () => 1 },
  user: { count: async () => 1 },
} as unknown as Prisma.TransactionClient;
const grant = (targetBinding: string): LocalA2AGrant => ({
  kind: "local",
  workspaceId: "ws",
  agentId: "agent",
  agentRevisionId: "revision-1",
  actorId: "actor",
  targetBinding,
  ownerKey: "owner",
  expiresAt: Date.now() + 60_000,
  scopes: ["a2a:send"],
  maxConcurrent: 1,
  timeoutSeconds: 60,
  retentionDays: 1,
  ancestorTaskIds: [],
  ancestorAgentIds: [],
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.agent.mockResolvedValue(structuredClone(agent));
  mocks.revision.mockImplementation(async (_tx, _agentId, revisionId) => ({
    id: revisionId ?? "revision-2",
    config,
  }));
});

describe("immutable native grant revision authority", () => {
  it("keeps an existing grant on its original revision after the published default advances", async () => {
    const pinned = await localTarget(
      tx,
      "ws",
      "agent",
      undefined,
      "revision-1",
    );
    const published = await localTarget(tx, "ws", "agent");
    expect(published.binding).not.toBe(pinned.binding);
    await expect(
      assertLocalGrant(grant(pinned.binding), tx),
    ).resolves.toBeUndefined();
    expect(mocks.revision).toHaveBeenLastCalledWith(tx, "agent", "revision-1");
  });

  it("does not rebuild immutable identity from mutable model or prompt settings", async () => {
    const pinned = await localTarget(
      tx,
      "ws",
      "agent",
      undefined,
      "revision-1",
    );
    mocks.agent.mockResolvedValue({
      ...agent,
      model: "new-default",
      systemPrompt: "New default instructions",
    });
    await expect(
      assertLocalGrant(grant(pinned.binding), tx),
    ).resolves.toBeUndefined();
  });

  it("never guesses a revision for persisted unresolved grants", async () => {
    const historical = {
      ...grant("old-binding"),
      agentRevisionId: undefined,
    } as unknown as LocalA2AGrant;
    await expect(assertLocalGrant(historical, tx)).rejects.toThrow();
    expect(mocks.revision).not.toHaveBeenCalled();
  });

  it.each(["pi", "hermes", "claude-code", "dsh", "hermes-rpc"])(
    "rejects retired %s targets",
    async (runtimeKind) => {
      mocks.agent.mockResolvedValue({ ...agent, runtimeKind });
      await expect(
        localTarget(tx, "ws", "agent", undefined, "revision-1"),
      ).rejects.toThrow();
      expect(mocks.revision).not.toHaveBeenCalled();
    },
  );

  it("intersects pinned local targets and Skills with live revocations", async () => {
    mocks.agent.mockResolvedValue({ ...agent, skills: [], subAgents: [] });
    const target = await localTarget(
      tx,
      "ws",
      "agent",
      undefined,
      "revision-1",
    );
    expect(target.targets).toEqual([]);
    expect(target.capabilityIds).toEqual([]);
    mocks.agent.mockResolvedValue({ ...agent, a2aOutboundEnabled: false });
    expect(
      (await localTarget(tx, "ws", "agent", undefined, "revision-1")).targets,
    ).toEqual([]);
  });

  it("propagates release revocation rather than minting a replacement authority", async () => {
    mocks.revision.mockRejectedValue(new Error("PI_PACKAGE_UNAVAILABLE"));
    await expect(
      localTarget(tx, "ws", "agent", undefined, "revision-1"),
    ).rejects.toThrow("PI_PACKAGE_UNAVAILABLE");
  });
});
