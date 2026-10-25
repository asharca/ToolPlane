import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { findFirst: vi.fn() },
  workspace: { findFirst: vi.fn() },
  agent: { findFirst: vi.fn() },
  deployment: { findFirst: vi.fn() },
  agentSandbox: { findFirst: vi.fn() },
  agentServer: { upsert: vi.fn() },
  query: vi.fn(),
  transaction: vi.fn(),
  pin: vi.fn(),
  publish: vi.fn(),
  prepare: vi.fn(),
  definitionChecksum: vi.fn(),
  runtimeFilesChecksum: vi.fn(),
  connection: vi.fn(),
  catalog: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    ...mocks,
    $queryRaw: mocks.query,
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/agents/revisions", () => ({
  pinCurrentAgentRevision: mocks.pin,
  publishAgentRevisionInTransaction: mocks.publish,
  AgentRevisionError: class extends Error {
    constructor(public code: string) {
      super(code);
    }
  },
}));
vi.mock("@/lib/process/mcp-definition", () => ({
  prepareSessionMcpDefinition: mocks.prepare,
  mcpDefinitionChecksum: mocks.definitionChecksum,
  mcpRuntimeFilesChecksum: mocks.runtimeFilesChecksum,
}));
vi.mock("@/lib/workspace/inspector-connection", () => ({
  readMcpInspectorConnection: mocks.connection,
}));
vi.mock("@/lib/process/mcp-tool-catalog", () => ({
  readMcpToolCatalog: mocks.catalog,
}));
vi.mock("@/lib/observability/audit", () => ({ writeAudit: vi.fn() }));

import { applyReviewedAgentMcpGrantsInTransaction } from "@/lib/agents/mutations";
import { db } from "@/lib/db";

const input = {
  workspaceId: "workspace",
  userId: "owner",
  agentId: "agent",
  deploymentId: "connector",
  expectedRevisionId: "published",
  allowedToolNames: ["read"],
};
const unrelatedGrant = {
  deploymentId: "other",
  allowedToolNames: ["existing"],
};
const publishedConfig = {
  systemPrompt: "Published prompt, not the mutable draft",
  model: "published-model",
  sandboxTemplateId: "sandbox",
  mcpGrants: [
    unrelatedGrant,
    { deploymentId: "connector", allowedToolNames: ["old"] },
  ],
};

async function applyReviewedSelection(
  allowedToolNames = input.allowedToolNames,
) {
  return db.$transaction((tx) =>
    applyReviewedAgentMcpGrantsInTransaction(tx, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      agentId: input.agentId,
      expectedRevisionId: input.expectedRevisionId,
      connections: [
        {
          deploymentId: input.deploymentId,
          allowedToolNames,
          prepared: {
            definitionChecksum: "definition",
            runtimeImageDigest: null,
          },
        },
      ],
    }),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.findFirst.mockResolvedValue({ role: "user" });
  mocks.workspace.findFirst.mockResolvedValue({ id: "workspace" });
  mocks.agent.findFirst.mockResolvedValue({ currentRevisionVersion: 1 });
  mocks.deployment.findFirst.mockResolvedValue({
    id: "connector",
    workspaceId: "workspace",
    source: "remote",
    installCfg: {},
    mcpToolExposure: "allowlist",
    mcpAllowedTools: ["read"],
  });
  mocks.agentSandbox.findFirst.mockResolvedValue({ sandboxId: "sandbox" });
  mocks.pin.mockResolvedValue({ id: "published", config: publishedConfig });
  mocks.prepare.mockResolvedValue({
    definitionChecksum: "definition",
    runtimeImageDigest: null,
  });
  mocks.definitionChecksum.mockReturnValue("definition");
  mocks.runtimeFilesChecksum.mockResolvedValue("files");
  mocks.connection.mockReturnValue({
    sandboxId: "sandbox",
    definitionChecksum: "definition",
    runtimeFilesChecksum: "files",
  });
  mocks.catalog.mockReturnValue([{ name: "read" }, { name: "unexposed" }]);
  mocks.publish.mockResolvedValue({ id: "next" });
  mocks.transaction.mockImplementation(async (callback) =>
    callback({
      ...mocks,
      $queryRaw: mocks.query,
    }),
  );
});

it("returns only reviewed authority alongside the unchanged applied config for caller publication", async () => {
  await expect(applyReviewedSelection()).resolves.toEqual({
    current: { id: "published", config: publishedConfig },
    grants: [
      {
        deploymentId: "connector",
        definitionChecksum: "definition",
        runtimeImageDigest: null,
        runtimeFilesChecksum: "files",
        allowedToolNames: ["read"],
      },
    ],
  });
  expect(mocks.agentServer.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      create: {
        agentId: "agent",
        deploymentId: "connector",
        allowedToolNames: ["read"],
      },
      update: { allowedToolNames: ["read"] },
    }),
  );
  expect(mocks.publish).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
});

it("rejects unauthorized users before writing any reviewed authority", async () => {
  mocks.workspace.findFirst.mockResolvedValue(null);
  await expect(applyReviewedSelection()).rejects.toThrow(
    "MCP_CONNECTION_NOT_AUTHORIZED",
  );
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.agentServer.upsert).not.toHaveBeenCalled();
});

it("does not attach or publish after a concurrent default revision change", async () => {
  mocks.pin.mockResolvedValue({ id: "concurrent", config: publishedConfig });
  await expect(applyReviewedSelection()).rejects.toThrow(
    "AGENT_REVISION_CONFLICT",
  );
  expect(mocks.agentServer.upsert).not.toHaveBeenCalled();
  expect(mocks.publish).not.toHaveBeenCalled();
});

it.each([
  {
    sandboxId: "other",
    definitionChecksum: "definition",
    runtimeFilesChecksum: "files",
  },
  {
    sandboxId: "sandbox",
    definitionChecksum: "changed",
    runtimeFilesChecksum: "files",
  },
  {
    sandboxId: "sandbox",
    definitionChecksum: "definition",
    runtimeFilesChecksum: "changed",
  },
  { sandboxId: "sandbox", connectedAt: new Date().toISOString() },
])("rejects stale or legacy discovery evidence %j", async (receipt) => {
  mocks.connection.mockReturnValue(receipt);
  await expect(applyReviewedSelection()).rejects.toThrow(
    "MCP_DISCOVERY_REQUIRED",
  );
  expect(mocks.publish).not.toHaveBeenCalled();
});

it("does not widen the Connector's global tool exposure", async () => {
  await expect(applyReviewedSelection(["unexposed"])).rejects.toThrow(
    "MCP_TOOLS_NOT_EXPOSED",
  );
  expect(mocks.agentServer.upsert).not.toHaveBeenCalled();
});

it("preserves an explicitly empty tool selection instead of adding discovered tools", async () => {
  const result = await applyReviewedSelection([]);
  expect(mocks.agentServer.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      create: {
        agentId: "agent",
        deploymentId: "connector",
        allowedToolNames: [],
      },
      update: { allowedToolNames: [] },
    }),
  );
  expect(result.grants).toEqual([
    expect.objectContaining({ allowedToolNames: [] }),
  ]);
  expect(result.current.config).toEqual(publishedConfig);
  expect(mocks.publish).not.toHaveBeenCalled();
});

it("narrows the live per-Agent allowlist rather than retaining previously pinned tool names", async () => {
  mocks.pin.mockResolvedValue({
    id: "published",
    config: {
      ...publishedConfig,
      mcpGrants: [
        unrelatedGrant,
        { deploymentId: "connector", allowedToolNames: ["read", "unexposed"] },
      ],
    },
  });
  await applyReviewedSelection();
  expect(mocks.agentServer.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      update: { allowedToolNames: ["read"] },
    }),
  );
});

it("authorizes a reviewed batch without publishing or incorporating mutable drafts", async () => {
  mocks.deployment.findFirst.mockImplementation(async ({ where }) => ({
    id: where.id,
    workspaceId: "workspace",
    source: "remote",
    installCfg: {},
    mcpToolExposure: "allowlist",
    mcpAllowedTools: ["read"],
  }));
  const reviewed = ["z-connector", "a-connector"].map((deploymentId) => ({
    deploymentId,
    allowedToolNames: ["read"],
    prepared: { definitionChecksum: "definition", runtimeImageDigest: null },
  }));
  const result = await db.$transaction((tx) =>
    applyReviewedAgentMcpGrantsInTransaction(tx, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      agentId: input.agentId,
      expectedRevisionId: input.expectedRevisionId,
      connections: reviewed,
    }),
  );
  expect(result.current.config).toEqual(publishedConfig);
  expect(result.grants).toEqual(
    ["a-connector", "z-connector"].map((deploymentId) => ({
      deploymentId,
      allowedToolNames: ["read"],
      definitionChecksum: "definition",
      runtimeImageDigest: null,
      runtimeFilesChecksum: "files",
    })),
  );
  expect(
    mocks.agentServer.upsert.mock.calls.map(
      ([call]) => call.update.allowedToolNames,
    ),
  ).toEqual([["read"], ["read"]]);
  expect(mocks.publish).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
});

it("rejects duplicate reviewed connections before writing any live authority", async () => {
  const connection = {
    deploymentId: input.deploymentId,
    allowedToolNames: ["read"],
    prepared: { definitionChecksum: "definition", runtimeImageDigest: null },
  };
  await expect(
    db.$transaction((tx) =>
      applyReviewedAgentMcpGrantsInTransaction(tx, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        agentId: input.agentId,
        expectedRevisionId: input.expectedRevisionId,
        connections: [connection, connection],
      }),
    ),
  ).rejects.toThrow("MCP_TOOL_SELECTION_CHANGED");
  expect(mocks.agentServer.upsert).not.toHaveBeenCalled();
  expect(mocks.publish).not.toHaveBeenCalled();
});

it("rejects a foreign or retired Agent before reading its pin or granting tools", async () => {
  mocks.agent.findFirst.mockResolvedValue(null);
  await expect(
    db.$transaction((tx) =>
      applyReviewedAgentMcpGrantsInTransaction(tx, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        agentId: "foreign-agent",
        expectedRevisionId: input.expectedRevisionId,
        connections: [
          {
            deploymentId: input.deploymentId,
            allowedToolNames: ["read"],
            prepared: {
              definitionChecksum: "definition",
              runtimeImageDigest: null,
            },
          },
        ],
      }),
    ),
  ).rejects.toThrow("AGENT_EXECUTION_RETIRED");
  expect(mocks.agent.findFirst).toHaveBeenCalledWith({
    where: {
      id: "foreign-agent",
      workspaceId: "workspace",
      runtimeKind: "pi-sdk",
      retiredAt: null,
      publicRuntimeAllocation: { is: null },
    },
    select: { id: true },
  });
  expect(mocks.pin).not.toHaveBeenCalled();
  expect(mocks.agentServer.upsert).not.toHaveBeenCalled();
});
