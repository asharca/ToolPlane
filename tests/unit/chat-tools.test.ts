// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mcpDefinitionChecksum } from "@/lib/process/mcp-definition";
import type { ChatAssistantRevisionConfig } from "@/lib/chat/revision-types";
import * as AgentTools from "@/lib/agents/tools";
import { logRequest } from "@/lib/observability/log";
import { McpToolNotDispatchedError } from "@/lib/remote-mcp/pinned-connection";
import type * as PinnedConnection from "@/lib/remote-mcp/pinned-connection";
import { loadMcpToolPolicies } from "@/lib/workspace/mcp-tool-exposure";
import type { McpTool } from "@/lib/process/mcp-client";

vi.mock("@/lib/process/manager", () => ({ startProcess: vi.fn() }));

const state = vi.hoisted(() => ({
  assistant: vi.fn(),
  grants: vi.fn(),
  current: vi.fn(),
  tools: vi.fn(),
  execute: vi.fn(),
  remote: vi.fn(),
  status: vi.fn(),
  exposed: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    chatAssistant: { findFirst: state.assistant },
    chatAssistantMcpGrant: { findMany: state.grants, findFirst: state.current },
  },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/process/supervisor", () => ({ liveStatus: state.status }));
vi.mock("@/lib/process/mcp-client", () => ({
  listMcpTools: vi.fn(),
  mcpRpc: vi.fn(),
}));
vi.mock("@/lib/observability/log", () => ({
  logRequest: vi.fn(async () => undefined),
}));
vi.mock("@/lib/workspace/mcp-tool-exposure", () => ({
  loadMcpToolPolicies: vi.fn(async () => new Map([["remote", {}]])),
  filterMcpToolsForAi: (tools: unknown[]) => tools,
  isMcpToolExposedToAi: state.exposed,
}));
vi.mock("@/lib/remote-mcp/pinned-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof PinnedConnection>()),
  listPinnedRemoteMcpTools: state.tools,
  callPinnedRemoteMcpTool: async (
    context: unknown,
    name: string,
    args: unknown,
    approved: unknown,
    options: unknown,
    beforeCall?: () => Promise<void>,
  ) => {
    await beforeCall?.();
    return state.execute(context, name, args, approved, options);
  },
}));
vi.mock("@/lib/chat/service", () => ({
  ChatServiceError: class extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  },
  requireChatRemoteDeployment: state.remote,
}));
import { buildChatToolSet } from "@/lib/chat/tools";

const deployment = {
  id: "remote",
  workspaceId: "workspace",
  serverId: null,
  name: "Remote",
  source: "remote",
  sourceRef: "https://mcp.example.com/mcp",
  installCfg: { transport: "streamable-http" },
  server: null,
  sandbox: null,
};
const config: ChatAssistantRevisionConfig = {
  schemaVersion: 1,
  systemPrompt: null,
  modelProviderId: null,
  model: null,
  modelParameters: null,
  maxSteps: 5,
  mcpGrants: [
    {
      deploymentId: deployment.id,
      allowedToolNames: ["read", "write"],
      definitionChecksum: mcpDefinitionChecksum(deployment),
    },
  ],
};
const scope = {
  assistantId: "assistant",
  workspaceId: "workspace",
  userId: "actor",
  config,
};
const grant = {
  assistantId: "assistant",
  deploymentId: deployment.id,
  allowedToolNames: ["read"],
  deployment,
};
const readToolKey = AgentTools.toolKey(deployment.id, "read");

function multipleDeploymentScope() {
  const otherDeployment = {
    ...deployment,
    id: "other-remote",
    sourceRef: "https://other.example.com/mcp",
  };
  state.grants.mockResolvedValue([
    grant,
    { ...grant, deploymentId: otherDeployment.id, deployment: otherDeployment },
  ]);
  vi.mocked(loadMcpToolPolicies).mockResolvedValueOnce(
    new Map([
      [deployment.id, { mode: "all", allowedTools: [] }],
      [otherDeployment.id, { mode: "all", allowedTools: [] }],
    ]),
  );
  return {
    ...scope,
    config: {
      ...config,
      mcpGrants: [
        ...config.mcpGrants,
        {
          deploymentId: otherDeployment.id,
          allowedToolNames: ["read"],
          definitionChecksum: mcpDefinitionChecksum(otherDeployment),
        },
      ],
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  state.status.mockReturnValue("running");
  state.exposed.mockReturnValue(true);
  state.assistant.mockResolvedValue({ id: scope.assistantId });
  state.grants.mockResolvedValue([grant]);
  state.current.mockResolvedValue(grant);
  state.remote.mockReturnValue(undefined);
  state.execute.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
  state.tools.mockResolvedValue(
    ["read", "write", "unapproved"].map((name) => ({
      name,
      description: name,
      inputSchema: { type: "object", properties: {} },
    })),
  );
});

describe("Assistant revision-bounded remote tools", () => {
  it("intersects pinned names and live grants without implicitly exposing tools", async () => {
    const tools = await buildChatToolSet(scope);
    expect(Object.keys(tools)).toEqual([readToolKey]);
    await tools[readToolKey].execute({ query: "test" }, { toolCallId: "call" });
    expect(state.execute).toHaveBeenCalledWith(
      {
        workspaceId: scope.workspaceId,
        deploymentId: deployment.id,
        definitionChecksum: config.mcpGrants[0].definitionChecksum,
      },
      "read",
      { query: "test" },
      ["read", "write"],
      { signal: undefined },
    );
    expect(state.current).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          assistantId: scope.assistantId,
          deploymentId: deployment.id,
          assistant: expect.objectContaining({
            workspaceId: scope.workspaceId,
          }),
        }),
      }),
    );
  });

  it("prepares stopped remote connections instead of silently dropping approved tools", async () => {
    state.status.mockReturnValue("stopped");
    const tools = await buildChatToolSet(scope);
    expect(Object.keys(tools)).toEqual([readToolKey]);
    expect(state.tools).toHaveBeenCalledWith(
      {
        workspaceId: scope.workspaceId,
        deploymentId: deployment.id,
        definitionChecksum: config.mcpGrants[0].definitionChecksum,
      },
      { signal: undefined },
    );
    expect(state.status).not.toHaveBeenCalled();
    state.current.mockResolvedValue({ ...grant, allowedToolNames: [] });
    await expect(tools[readToolKey].execute({})).rejects.toMatchObject({
      status: 403,
    });
    expect(state.execute).not.toHaveBeenCalled();
  });

  it("reports stopped remote preparation failures instead of returning an empty tool set", async () => {
    state.status.mockReturnValue("stopped");
    state.tools.mockRejectedValue(new Error("MCP_CONNECTION_UNAVAILABLE"));
    await expect(buildChatToolSet(scope)).rejects.toThrow(
      "MCP_CONNECTION_UNAVAILABLE",
    );
    expect(state.tools).toHaveBeenCalledOnce();
    expect(state.execute).not.toHaveBeenCalled();
  });

  it("keeps deployment order and fresh authority when discoveries finish out of order", async () => {
    const multiScope = multipleDeploymentScope();
    const first = Promise.withResolvers<McpTool[]>();
    const second = Promise.withResolvers<McpTool[]>();
    state.tools.mockImplementation(
      ({ deploymentId }: { deploymentId: string }) =>
        deploymentId === deployment.id ? first.promise : second.promise,
    );
    const preparation = buildChatToolSet(multiScope);
    const outcome = Promise.allSettled([preparation]);
    try {
      await vi.waitFor(() => expect(state.tools).toHaveBeenCalledTimes(2));
      second.resolve([{ name: "read" }, { name: "unapproved" }]);
      first.resolve([{ name: "write" }, { name: "read" }]);
      const tools = await preparation;
      expect(Object.keys(tools)).toEqual([
        readToolKey,
        AgentTools.toolKey("other-remote", "read"),
      ]);
      state.current.mockResolvedValue({ ...grant, allowedToolNames: [] });
      await expect(tools[readToolKey].execute({})).rejects.toMatchObject({
        status: 403,
      });
      expect(state.execute).not.toHaveBeenCalled();
    } finally {
      first.resolve([]);
      second.resolve([]);
      await outcome;
    }
  });

  it.each(["failure", "cancellation"] as const)(
    "drains all deployment discovery after %s before rejecting preparation",
    async (kind) => {
      const multiScope = multipleDeploymentScope();
      const controller = new AbortController();
      const first = Promise.withResolvers<McpTool[]>();
      const second = Promise.withResolvers<McpTool[]>();
      const firstError =
        kind === "cancellation"
          ? new DOMException("Stopped", "AbortError")
          : new Error("First deployment failed");
      const secondError = new Error("Second deployment failed first");
      state.tools.mockImplementation(
        ({ deploymentId }: { deploymentId: string }) =>
          deploymentId === deployment.id ? first.promise : second.promise,
      );
      let settled = false;
      const outcome = buildChatToolSet({
        ...multiScope,
        signal: controller.signal,
      }).then(
        (value) => {
          settled = true;
          return { value, error: undefined };
        },
        (error: unknown) => {
          settled = true;
          return { value: undefined, error };
        },
      );
      try {
        await vi.waitFor(() => expect(state.tools).toHaveBeenCalledTimes(2));
        if (kind === "cancellation") controller.abort(firstError);
        second.reject(secondError);
        // Give rejection handlers a turn; the other deployment still owns work.
        const tick = Promise.withResolvers<void>();
        setImmediate(tick.resolve);
        await tick.promise;
        expect(settled).toBe(false);
        expect(state.execute).not.toHaveBeenCalled();
        first.reject(firstError);
        expect((await outcome).error).toBe(firstError);
      } finally {
        first.resolve([]);
        second.resolve([]);
        await outcome;
      }
    },
  );

  it("classifies only an explicit fresh exposure rejection as not dispatched", async () => {
    const tools = await buildChatToolSet(scope);
    state.exposed.mockReturnValue(false);
    const outcome = tools[readToolKey].execute({});
    await expect(outcome).rejects.toBeInstanceOf(McpToolNotDispatchedError);
    await expect(outcome).rejects.toMatchObject({
      message: "MCP tool read is not exposed to AI.",
      cause: { status: 403 },
    });
    expect(logRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: scope.workspaceId,
        deploymentId: deployment.id,
        statusCode: 403,
        outcome: "denied",
      }),
    );
    expect(state.execute).not.toHaveBeenCalled();
    expect(state.current).not.toHaveBeenCalled();
  });

  it("does not reinterpret a dispatched remote error result as a predispatch refusal", async () => {
    const result = {
      error: "Remote operation returned an application failure",
    };
    state.execute.mockResolvedValue(result);
    const tools = await buildChatToolSet(scope);
    await expect(tools[readToolKey].execute({})).resolves.toEqual(result);
    expect(state.execute).toHaveBeenCalledOnce();
  });

  it("rechecks live grants after a tool was offered and before each invocation", async () => {
    const tools = await buildChatToolSet(scope);
    await tools[readToolKey].execute({});
    state.current.mockResolvedValue({ ...grant, allowedToolNames: [] });
    await expect(tools[readToolKey].execute({})).rejects.toMatchObject({
      status: 403,
    });
    expect(state.execute).toHaveBeenCalledOnce();
  });

  it("rejects a retargeted connection even when its deployment ID and grant survive", async () => {
    const tools = await buildChatToolSet(scope);
    state.current.mockResolvedValue({
      ...grant,
      deployment: { ...deployment, sourceRef: "https://other.example.com/mcp" },
    });
    await expect(tools[readToolKey].execute({})).rejects.toMatchObject({
      status: 409,
    });
    expect(state.execute).not.toHaveBeenCalled();
    state.grants.mockResolvedValue([
      {
        ...grant,
        deployment: { ...deployment, installCfg: { transport: "sse" } },
      },
    ]);
    await expect(buildChatToolSet(scope)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("allows credential-value rotation but not authority changes", async () => {
    const authenticated = {
      ...deployment,
      installCfg: {
        transport: "streamable-http",
        authType: "bearer",
        bearerEnv: "TOKEN",
        env: { TOKEN: "before" },
      },
    };
    const rotated = {
      ...authenticated,
      installCfg: { ...authenticated.installCfg, env: { TOKEN: "after" } },
    };
    const pinned = {
      ...config,
      mcpGrants: [
        {
          ...config.mcpGrants[0],
          definitionChecksum: mcpDefinitionChecksum(authenticated),
        },
      ],
    };
    state.grants.mockResolvedValue([{ ...grant, deployment: rotated }]);
    state.current.mockResolvedValue({ ...grant, deployment: rotated });
    const tools = await buildChatToolSet({ ...scope, config: pinned });
    await tools[readToolKey].execute({});
    expect(state.execute).toHaveBeenCalledOnce();
  });

  it("denies cross-workspace execution and revalidates the actual remote recipe", async () => {
    state.grants.mockResolvedValue([
      { ...grant, deployment: { ...deployment, workspaceId: "other" } },
    ]);
    await expect(buildChatToolSet(scope)).rejects.toMatchObject({
      status: 403,
    });
    expect(state.tools).not.toHaveBeenCalled();
    state.grants.mockResolvedValue([grant]);
    state.remote.mockImplementation(() => {
      throw new Error("stdio is not remote");
    });
    await expect(buildChatToolSet(scope)).rejects.toThrow(
      "stdio is not remote",
    );
    expect(state.tools).not.toHaveBeenCalled();
  });
});
