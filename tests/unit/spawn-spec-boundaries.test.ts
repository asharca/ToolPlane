import { describe, expect, it } from "vitest";
import { resolveSpawnSpec } from "@/lib/process/spawn-spec";

const deployment = {
  serverId: null,
  server: null,
  name: null,
  source: "remote",
  sourceRef: "https://mcp.example.test/mcp",
  installCfg: {},
};
describe("remote MCP spawn configuration security", () => {
  it.each([
    [null, "configuration is invalid"],
    [[], "configuration is invalid"],
    [{ transport: "websocket" }, "transport must be"],
    [{ authType: "password" }, "authentication type is invalid"],
    [{ timeoutMs: 999 }, "timeout must be"],
    [{ timeoutMs: 600001 }, "timeout must be"],
    [{ timeoutMs: 1000.5 }, "timeout must be"],
    [
      { authType: "bearer", bearerEnv: "bad-name" },
      "credential reference is invalid",
    ],
    [
      { authType: "bearer", bearerEnv: "TOKEN", env: { TOKEN: 42 } },
      "not configured",
    ],
    [{ authType: "bearer", bearerEnv: "TOKEN", env: [] }, "not configured"],
    [
      { authType: "headers", headerEnv: [] },
      "custom header configuration is invalid",
    ],
    [{ authType: "headers", headerEnv: {} }, "between 1 and 32"],
    [
      {
        authType: "headers",
        headerEnv: Object.fromEntries(
          Array.from({ length: 33 }, (_, i) => [`x-${i}`, "TOKEN"]),
        ),
      },
      "between 1 and 32",
    ],
    [
      {
        authType: "headers",
        headerEnv: { Host: "TOKEN" },
        env: { TOKEN: "private" },
      },
      "header is not allowed",
    ],
    [
      {
        authType: "headers",
        headerEnv: { "x-header": "TOKEN", "X-Header": "TOKEN" },
        env: { TOKEN: "private" },
      },
      "header is not allowed",
    ],
    [
      {
        authType: "headers",
        headerEnv: { "x-invalid header": "TOKEN" },
        env: { TOKEN: "private" },
      },
      "header is not allowed",
    ],
    [
      {
        authType: "headers",
        headerEnv: { "x-header": "TOKEN" },
        env: { TOKEN: "value\r\ninjected: yes" },
      },
      "Remote MCP credential has an invalid header value.",
    ],
    [
      {
        authType: "headers",
        headerEnv: { "x-header": "TOKEN" },
        env: { TOKEN: "x".repeat(8193) },
      },
      "Remote MCP credential has an invalid header value.",
    ],
  ])(
    "rejects invalid remote credentials before launch",
    (installCfg, message) => {
      expect(() => resolveSpawnSpec({ ...deployment, installCfg })).toThrow(
        String(message),
      );
    },
  );
  it.each([
    null,
    "not-a-url",
    "file:///etc/passwd",
    "https://user:password@mcp.example.test/mcp",
    "https://mcp.example.test/mcp?token=secret",
    "https://mcp.example.test/mcp#fragment",
  ])("rejects unsafe remote endpoint %s", (sourceRef) => {
    expect(() => resolveSpawnSpec({ ...deployment, sourceRef })).toThrow();
  });
  it.each([undefined, false, "true", 1])(
    "rejects plaintext HTTP without boolean approval (%s)",
    (allowUnsafeHttp) => {
      expect(() =>
        resolveSpawnSpec({
          ...deployment,
          sourceRef: "http://mcp.example.test/mcp",
          installCfg: { allowUnsafeHttp },
        }),
      ).toThrow("Remote MCP HTTP requires explicit plaintext-risk approval.");
    },
  );
  it("supports boundary timeouts and keeps remote credentials out of the endpoint", () => {
    for (const timeoutMs of [1000, 600000]) {
      expect(
        resolveSpawnSpec({
          ...deployment,
          installCfg: {
            transport: "sse",
            authType: "headers",
            timeoutMs,
            headerEnv: { "X-API-Key": "TOKEN" },
            env: { TOKEN: "private-value" },
          },
        }),
      ).toEqual({
        kind: "remote",
        name: "Remote MCP",
        url: deployment.sourceRef,
        transport: "sse",
        timeoutMs,
        headers: { "X-API-Key": "private-value" },
        allowUnsafeHttp: false,
      });
    }
  });
  it("defaults missing sandbox configuration safely and rejects legacy SSH launch data", () => {
    expect(
      resolveSpawnSpec({ ...deployment, source: "sandbox", installCfg: null }),
    ).toEqual({
      kind: "sandbox",
      name: "Sandbox",
      sandboxId: "",
      sandboxKind: "docker",
      network: "isolated",
      env: {},
    });
    expect(() =>
      resolveSpawnSpec({
        ...deployment,
        source: "sandbox",
        installCfg: { kind: "ssh", host: "attacker.test" },
      }),
    ).toThrow("Legacy SSH configuration is disabled");
    expect(
      resolveSpawnSpec({
        ...deployment,
        source: "sandbox",
        installCfg: {
          sandboxId: "sandbox",
          kind: "ssh",
          sshTargetId: "approved",
        },
      }),
    ).toMatchObject({
      kind: "sandbox",
      sandboxKind: "ssh",
      sshTargetId: "approved",
    });
  });
});
