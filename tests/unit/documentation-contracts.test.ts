import { assertDefined } from "../assert-defined";
// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  AGENT_CONTROL_RUNTIME_KINDS,
  agentRuntimeCapabilities,
} from "@/lib/agents/runtime-kind";

const control = vi.hoisted(() => ({
  create: vi.fn(async () => ({ id: "example-agent" })),
}));
vi.mock("@/lib/agents/control-service", () => ({
  AgentControlError: class extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
  createAgentFromControl: control.create,
  getAgentControlAgent: vi.fn(),
  inspectAgentControlDeployment: vi.fn(),
  listAgentControlAgents: vi.fn(),
  listAgentControlResources: vi.fn(),
  sendAgentControlMessage: vi.fn(),
}));
import {
  AGENT_CONTROL_MCP_TOOLS,
  executeAgentControlTool,
} from "@/lib/agents/control-mcp";

const docs = path.join(process.cwd(), "docs");
const read = (file: string) => readFileSync(path.join(docs, file), "utf8");

describe("production capabilities and bilingual documentation contracts", () => {
  it.each(["AGENT_CONTROL_MCP.md", "AGENT_CONTROL_MCP.zh-CN.md"])(
    "validates the actual JSON-RPC example in %s through the production parser",
    async (file) => {
      const match = /-d '(\{[\s\S]*?\})'/.exec(read(file));
      expect(match).not.toBeNull();
      const request = JSON.parse(assertDefined(match)[1]);
      expect(request).toMatchObject({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "create_agent", arguments: { runtime: "pi-sdk" } },
      });
      await expect(
        executeAgentControlTool(
          { workspaceId: "ws", workspaceSlug: "acme" },
          request.params.name,
          request.params.arguments,
        ),
      ).resolves.toEqual({ id: "example-agent" });
      expect(control.create).toHaveBeenLastCalledWith(
        "ws",
        "acme",
        expect.objectContaining({ runtime: "pi-sdk" }),
      );
    },
  );
  it.each(["native", "pi", "hermes", "claude-code", "dsh", "hermes-rpc"])(
    "keeps unsupported Control MCP creation runtime %s rejected",
    async (runtime) => {
      control.create.mockClear();
      await expect(
        executeAgentControlTool(
          { workspaceId: "ws", workspaceSlug: "acme" },
          "create_agent",
          { name: "No side effect", runtime },
        ),
      ).rejects.toMatchObject({ code: "invalid_arguments" });
      expect(control.create).not.toHaveBeenCalled();
    },
  );
  it("keeps runtime capabilities complete without widening the Control MCP subset", () => {
    const create = assertDefined(
      AGENT_CONTROL_MCP_TOOLS.find((tool) => tool.name === "create_agent"),
    );
    expect(create.inputSchema.properties.runtime.enum).toEqual(
      AGENT_CONTROL_RUNTIME_KINDS,
    );
    expect(AGENT_CONTROL_RUNTIME_KINDS).toEqual(["pi-sdk"]);
    expect(agentRuntimeCapabilities("native")).toBeNull();
    expect(agentRuntimeCapabilities("hermes")).toMatchObject({
      attachments: true,
      providerBinding: "multiple",
    });
    for (const kind of ["pi", "pi-sdk", "claude-code", "dsh", "hermes-rpc"])
      expect(agentRuntimeCapabilities(kind)).toMatchObject({
        attachments: false,
        providerBinding: "single",
      });
  });
  it("keeps every topic bilingual, top-linked and registered in both indexes", () => {
    const names = readdirSync(docs).filter(
      (name) => /^[A-Z_]+\.md$/.test(name) && name !== "README.md",
    );
    for (const name of names) {
      const stem = name.slice(0, -3);
      const counterpart = existsSync(path.join(docs, `${stem}.en.md`))
        ? `${stem}.en.md`
        : `${stem}.zh-CN.md`;
      expect(existsSync(path.join(docs, counterpart)), counterpart).toBe(true);
      expect(read(name).split("\n").slice(0, 8).join("\n")).toContain(
        `](./${counterpart})`,
      );
      expect(read(counterpart).split("\n").slice(0, 8).join("\n")).toContain(
        `](./${name})`,
      );
      for (const index of ["README.md", "README.zh-CN.md"]) {
        expect(read(index), index).toContain(`](./${name})`);
        expect(read(index), index).toContain(`](./${counterpart})`);
      }
    }
  });
  it("resolves relative links and linked source entry points in maintained topic docs", () => {
    for (const file of readdirSync(docs).filter((file) =>
      file.endsWith(".md"),
    )) {
      for (const [, target] of read(file).matchAll(
        /\]\((\.{1,2}\/[^)\s]+)\)/g,
      )) {
        const pathname = target.split("#")[0];
        expect(
          existsSync(path.resolve(docs, decodeURIComponent(pathname))),
          `${file}: ${target}`,
        ).toBe(true);
      }
    }
  });
});
