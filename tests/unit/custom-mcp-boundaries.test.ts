import { describe, expect, it } from "vitest";
import {
  mcpConfigErrorDetail,
  parseMcpDeploymentConfig,
  parseMcpJsonConfig,
  serializeMcpDeploymentConfig,
} from "@/lib/workspace/custom-mcp";

describe("MCP configuration trust boundaries", () => {
  it.each([
    [{ args: Array(101).fill("x") }, "more than 100"],
    [{ args: ["x".repeat(4001)] }, "each arg"],
    [{ args: ["bad\0arg"] }, "each arg"],
    [{ args: Array(9).fill("x".repeat(4000)) }, "characters in total"],
    [{ env: null }, "env must be an object"],
    [{ env: [] }, "env must be an object"],
    [
      {
        env: Object.fromEntries(
          Array.from({ length: 101 }, (_, i) => [`K${i}`, ""]),
        ),
      },
      "more than 100",
    ],
    [{ env: { TOKEN: 123 } }, "bounded string"],
    [{ env: { TOKEN: "x".repeat(16001) } }, "bounded string"],
    [{ env: { TOKEN: "bad\0secret" } }, "bounded string"],
    [
      {
        env: Object.fromEntries(
          Array.from({ length: 5 }, (_, i) => [`K${i}`, "x".repeat(16000)]),
        ),
      },
      "characters in total",
    ],
    [{ command: " " }, "command is required"],
  ])("rejects bounded-input violations %#", (overrides, detail) => {
    expect(() =>
      parseMcpJsonConfig(
        JSON.stringify({ command: "npx", args: ["server"], ...overrides }),
      ),
    ).toThrow(detail);
  });

  it.each([
    ["{broken", "enter valid JSON"],
    ["null", "top level must be an object"],
    ["[]", "top level must be an object"],
    [JSON.stringify({ mcpServers: [] }), "mcpServers must be an object"],
    [JSON.stringify({ server: null }), "server config must be an object"],
    [
      JSON.stringify({
        ["a".repeat(81)]: { command: "npx", args: ["server"] },
      }),
      "server name",
    ],
  ])("rejects malformed document %s", (raw, detail) => {
    expect(() => parseMcpJsonConfig(raw)).toThrow(detail);
  });

  it.each([
    null,
    [],
    { Authorization: 1 },
    { Authorization: "Bearer bad\nsecret" },
    { Authorization: `Bearer ${"x".repeat(8192)}` },
  ])("rejects malformed remote headers %#", (headers) => {
    expect(() =>
      parseMcpJsonConfig(
        JSON.stringify({
          remote: { type: "http", url: "https://example.com/mcp", headers },
        }),
      ),
    ).toThrow(/headers must be an object|Authorization header is invalid/);
  });

  it("accepts an explicitly empty remote header map without inventing credentials", () => {
    expect(
      parseMcpJsonConfig(
        JSON.stringify({
          remote: { type: "http", url: "https://example.com/mcp", headers: {} },
        }),
      ).installCfg,
    ).toEqual({ env: {}, transport: "streamable-http", authType: "none" });
  });

  it.each([
    [["--", "fetch-server@latest"], "fetch-server"],
    [["https://example.com/server", "bad\\path", "123"], "mcp-server"],
    [["-y", "@scope/fetch-server@2"], "fetch-server"],
  ])(
    "infers names without treating URLs and numeric arguments as packages",
    (args, name) => {
      expect(
        parseMcpJsonConfig(JSON.stringify({ command: "npx", args })).name,
      ).toBe(name);
    },
  );

  it("infers the image name for Docker configurations", () => {
    expect(
      parseMcpJsonConfig(
        JSON.stringify({
          command: "docker",
          args: ["run", "--rm", "-i", "org/fetch-server:latest"],
        }),
      ).name,
    ).toBe("fetch-server");
  });

  it.each(["not-json", "null", "[]"])(
    "rejects invalid package editing documents %s",
    (raw) => {
      expect(() => parseMcpDeploymentConfig(raw, "npm")).toThrow(
        "Invalid MCP JSON config:",
      );
    },
  );

  it.each([123, "bad\0command", "x".repeat(32001)])(
    "rejects unsafe Docker start commands %#",
    (startCommand) => {
      expect(() =>
        parseMcpDeploymentConfig(
          JSON.stringify({ source: "docker", ref: "org/server", startCommand }),
          "docker",
        ),
      ).toThrow("startCommand must be a string");
    },
  );

  it("does not let an edited stdio configuration become a remote endpoint", () => {
    expect(() =>
      parseMcpDeploymentConfig(
        JSON.stringify({
          remote: { type: "http", url: "https://example.com/mcp" },
        }),
        "config",
      ),
    ).toThrow("command configuration is invalid");
    expect(() =>
      serializeMcpDeploymentConfig({
        source: null,
        sourceRef: null,
        installCfg: null,
      }),
    ).toThrow("Unsupported editable MCP source: (none)");
  });

  it("exposes only bounded printable validation details", () => {
    expect(
      mcpConfigErrorDetail(new Error("Invalid MCP JSON config: bad input")),
    ).toBe("bad input");
    for (const error of [
      null,
      "Invalid MCP JSON config: fake",
      new Error("unrelated"),
      new Error("Invalid MCP JSON config: "),
      new Error(`Invalid MCP JSON config: ${"x".repeat(241)}`),
      new Error("Invalid MCP JSON config: bad\ninput"),
      new Error("Invalid MCP JSON config: bad\x7finput"),
    ]) {
      expect(mcpConfigErrorDetail(error)).toBeNull();
    }
  });
});
