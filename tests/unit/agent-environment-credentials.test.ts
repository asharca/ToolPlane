import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    agent: { findFirst: vi.fn() },
    conversation: { findFirst: vi.fn() },
    a2AContext: { findFirst: vi.fn() },
    agentEnvironmentCredential: {
      create: vi.fn(),
      updateMany: vi.fn(),
      findMany: vi.fn(),
    },
  };
  return { tx, revision: vi.fn(), audit: vi.fn() };
});
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  db: {
    $transaction: (callback: (tx: typeof mocks.tx) => unknown) =>
      callback(mocks.tx),
  },
}));
vi.mock("@/lib/observability/audit", () => ({ writeAudit: mocks.audit }));
vi.mock("@/lib/agents/revisions", () => ({
  AgentRevisionError: class extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
  requireAgentRevision: mocks.revision,
}));

import {
  createAgentEnvironmentCredential,
  revokeAgentEnvironmentCredential,
  resolveAgentEnvironmentCredentials,
} from "@/lib/agents/environment-credentials";
import { encryptSecretText, decryptSecretText } from "@/lib/security/secrets";

const identity = {
  workspaceId: "workspace",
  agentId: "agent",
  name: "SERVICE_TOKEN",
};
const owner = { ...identity, actorUserId: "owner" };
const session = {
  workspaceId: "workspace",
  agentId: "agent",
  agentRevisionId: "revision",
  conversationId: "conversation",
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.tx.agent.findFirst.mockResolvedValue({ id: identity.agentId });
  mocks.tx.conversation.findFirst.mockResolvedValue({
    id: session.conversationId,
  });
  mocks.revision.mockResolvedValue({
    config: {
      environment: {
        credentialReferences: [
          { name: identity.name, credentialId: "credential" },
        ],
      },
    },
  });
});

describe("Agent environment credential authority", () => {
  it("encrypts a bound identity and never returns or audits its value", async () => {
    mocks.tx.agentEnvironmentCredential.create.mockResolvedValue({
      id: "created",
      name: identity.name,
      revokedAt: null,
    });
    const result = await createAgentEnvironmentCredential({
      ...owner,
      value: "secret-token",
    });
    const request = mocks.tx.agentEnvironmentCredential.create.mock.calls[0][0];
    expect(JSON.parse(decryptSecretText(request.data.encryptedValue))).toEqual({
      ...identity,
      id: request.data.id,
      value: "secret-token",
    });
    expect(request.select).toEqual({
      id: true,
      name: true,
      createdAt: true,
      revokedAt: true,
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(
      "secret-token",
    );
  });

  it("requires owner authority before persisting a credential", async () => {
    mocks.tx.agent.findFirst.mockResolvedValue(null);
    await expect(
      createAgentEnvironmentCredential({ ...owner, value: "secret-token" }),
    ).rejects.toMatchObject({ code: "AGENT_CREDENTIAL_FORBIDDEN" });
    expect(mocks.tx.agent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspace: { ownerId: "owner", status: "active" },
          runtimeKind: "pi-sdk",
          retiredAt: null,
        }),
      }),
    );
    expect(mocks.tx.agentEnvironmentCredential.create).not.toHaveBeenCalled();
  });

  it.each([
    "TOOLPLANE_RUNTIME_TOKEN",
    "AUTH_SECRET",
    "NODE_OPTIONS",
    "HOME",
    "PATH",
  ])("rejects platform-reserved name %s", async (name) => {
    await expect(
      createAgentEnvironmentCredential({
        ...owner,
        name,
        value: "secret-token",
      }),
    ).rejects.toMatchObject({ code: "AGENT_CREDENTIAL_NAME_INVALID" });
    expect(mocks.tx.agentEnvironmentCredential.create).not.toHaveBeenCalled();
  });

  it("decrypts only the persisted session revision allowlist", async () => {
    mocks.tx.agentEnvironmentCredential.findMany
      .mockResolvedValueOnce([{ id: "credential", name: identity.name }])
      .mockResolvedValueOnce([
        {
          id: "credential",
          name: identity.name,
          encryptedValue: encryptSecretText(
            JSON.stringify({
              ...identity,
              id: "credential",
              value: "session-secret",
            }),
          ),
        },
      ]);
    expect(await resolveAgentEnvironmentCredentials(session)).toEqual({
      SERVICE_TOKEN: "session-secret",
    });
    expect(mocks.revision).toHaveBeenCalledWith(mocks.tx, "agent", "revision");
    expect(
      mocks.tx.agentEnvironmentCredential.findMany,
    ).toHaveBeenNthCalledWith(2, {
      where: {
        id: { in: ["credential"] },
        workspaceId: "workspace",
        agentId: "agent",
        revokedAt: null,
      },
      select: { id: true, name: true, encryptedValue: true },
    });
  });

  it("denies unresolved sessions before reading any credential", async () => {
    mocks.tx.conversation.findFirst.mockResolvedValue(null);
    await expect(
      resolveAgentEnvironmentCredentials(session),
    ).rejects.toMatchObject({ code: "AGENT_REVISION_UNRESOLVED" });
    expect(mocks.tx.agentEnvironmentCredential.findMany).not.toHaveBeenCalled();
  });

  it("honors live revocation before decryption", async () => {
    mocks.tx.agentEnvironmentCredential.findMany.mockResolvedValue([]);
    await expect(
      resolveAgentEnvironmentCredentials(session),
    ).rejects.toMatchObject({ code: "AGENT_CREDENTIAL_REVOKED" });
    expect(mocks.tx.agentEnvironmentCredential.findMany).toHaveBeenCalledTimes(
      1,
    );
  });

  it("rejects ciphertext copied from a different Agent", async () => {
    mocks.tx.agentEnvironmentCredential.findMany
      .mockResolvedValueOnce([{ id: "credential", name: identity.name }])
      .mockResolvedValueOnce([
        {
          id: "credential",
          name: identity.name,
          encryptedValue: encryptSecretText(
            JSON.stringify({
              ...identity,
              agentId: "other-agent",
              id: "credential",
              value: "stolen",
            }),
          ),
        },
      ]);
    await expect(
      resolveAgentEnvironmentCredentials(session),
    ).rejects.toMatchObject({ code: "AGENT_CREDENTIAL_INVALID" });
  });

  it("revokes only the owned credential and does not clear prior revocations", async () => {
    mocks.tx.agentEnvironmentCredential.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const input = { ...owner, credentialId: "credential" };
    expect(await revokeAgentEnvironmentCredential(input)).toEqual({
      revoked: true,
    });
    expect(await revokeAgentEnvironmentCredential(input)).toEqual({
      revoked: false,
    });
    expect(mocks.tx.agentEnvironmentCredential.updateMany).toHaveBeenCalledWith(
      {
        where: {
          id: "credential",
          workspaceId: "workspace",
          agentId: "agent",
          revokedAt: null,
        },
        data: { revokedAt: expect.any(Date) },
      },
    );
    expect(mocks.audit).toHaveBeenCalledTimes(1);
  });
});

it("fails closed if revocation occurs between identity validation and decryption", async () => {
  mocks.tx.agentEnvironmentCredential.findMany
    .mockResolvedValueOnce([{ id: "credential", name: identity.name }])
    .mockResolvedValueOnce([]);
  await expect(
    resolveAgentEnvironmentCredentials(session),
  ).rejects.toMatchObject({ code: "AGENT_CREDENTIAL_REVOKED" });
});
