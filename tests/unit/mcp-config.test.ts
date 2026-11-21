import { describe, expect, it } from "vitest";
import { analyzeText } from "@/lib/workspace/mcp-intake";
import {
  mcpDocumentDiff,
  normalizeMcpDocument,
} from "@/lib/workspace/mcp-config";

const literal = 'quoted"private=value';

describe("original MCP documents", () => {
  it("isolates each entry, preserving JSONC comments, property order, and ignored fields", () => {
    const one = `{ // keep this note\n  "timeout": 30, "command": "bin/server",\n  "env": {"TOKEN": ${JSON.stringify(literal)}},\n}`;
    const two =
      '{"url":"https://example.org/mcp","headers":{"X-Api-Key":"header-value"}}';
    const [first, second] = analyzeText(
      `{"mcpServers":{"one":${one},"two":${two}}}`,
    );
    expect(first.document).toBe(
      one.replace(JSON.stringify(literal), `"\${TOKEN}"`),
    );
    expect(first.draft.ignoredFields).toEqual(["timeout"]);
    expect(JSON.parse(first.draft.config)).not.toHaveProperty("timeout");
    expect(second.document).toBe(
      two.replace("header-value", `\${MCP_X_API_KEY}`),
    );
    expect(second.document).not.toContain("keep this note");
  });
  it("extracts all sensitive argv forms and Docker env assignments even when they contain '='", () => {
    const args = [
      "run",
      "--env=API_KEY=private-mode",
      "pkg:1",
      "--api-key=secret=one",
      "--token",
      "secret=two",
      "--header",
      "Authorization: Basic secret-three",
    ];
    const [entry] = analyzeText(JSON.stringify({ command: "docker", args }));
    const publicData = JSON.stringify([entry.draft, entry.document]);
    for (const value of [
      "private-mode",
      "secret=one",
      "secret=two",
      "Authorization: Basic secret-three",
    ]) {
      expect(publicData).not.toContain(value);
      expect(Object.values(entry.literals)).toContain(value);
    }
    expect(analyzeText(entry.document)[0].literals).toEqual({});
  });
  it("rejects ambiguous JSON and repeated literal secrets outside their credential slots", () => {
    for (const doc of [
      '{"command":"x","env":{"KEY":"unsealed-value","KEY":"other"}}',
      '{"command":"x","env":{"KEY":"unsealed-value"},"comment":"unsealed-value"}',
      '{"command":"x","__proto__":{}}',
    ])
      expect(() => normalizeMcpDocument(doc)).toThrow();
  });
  it("reports only changed lines, using sanitized documents", () => {
    const old = normalizeMcpDocument(
      '{\n "command":"x",\n "env":{"TOKEN":"private-old"}\n}',
    ).document;
    const next = normalizeMcpDocument(
      '{\n "command":"y",\n "env":{"TOKEN":"private-new"}\n}',
    ).document;
    expect(mcpDocumentDiff(old, next)).toEqual([
      { type: "removed", line: ' "command":"x",' },
      { type: "added", line: ' "command":"y",' },
    ]);
  });
});
