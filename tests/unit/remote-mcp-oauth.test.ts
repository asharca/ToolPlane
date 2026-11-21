// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  asMetadataUrls,
  challengeParams,
  issuerId,
  makeAuthorizationProof,
  stateHash,
} from "@/lib/remote-mcp/oauth/protocol";
import { analyzeText, applyCreateItem } from "@/lib/workspace/mcp-intake";

describe("remote MCP authorization", () => {
  it("tries RFC 8414 and both path-based OIDC discovery forms in order", () => {
    expect(asMetadataUrls("https://provider.test/org")).toEqual([
      "https://provider.test/.well-known/oauth-authorization-server/org",
      "https://provider.test/.well-known/openid-configuration/org",
      "https://provider.test/org/.well-known/openid-configuration",
    ]);
    expect(asMetadataUrls("https://provider.test/")).toHaveLength(2);
  });
  it.each([
    "http://provider.test",
    "https://user@provider.test",
    "https://provider.test/path?x",
    "https://provider.test/#section",
  ])("rejects invalid issuer %s", (issuer) => {
    expect(() => issuerId(issuer)).toThrow();
  });
  it("extracts the challenge resource and requested scopes", () => {
    expect(
      challengeParams(
        'Bearer realm="mcp", scope="read write", resource_metadata="https://resource.test/meta"',
      ),
    ).toEqual({ metadata: "https://resource.test/meta", scope: "read write" });
  });
  it("uses independent high entropy state and S256 proof", () => {
    const { state, verifier, challenge } = makeAuthorizationProof();
    expect(challenge).toBe(
      createHash("sha256").update(verifier).digest("base64url"),
    );
    expect(verifier).not.toBe(state);
    expect(stateHash(state)).toHaveLength(64);
    expect(makeAuthorizationProof().state).not.toBe(state);
  });
  it("adopts the GitHub preset by URL and never copies static token fields into an OAuth deployment", () => {
    const [entry] = analyzeText("https://api.githubcopilot.com/mcp/");
    expect(entry.draft.presetId).toBe("github");
    expect(entry.draft.fields[0].helpUrl).toContain("github.com/");
    const item = {
      id: entry.draft.id,
      name: "GitHub",
      values: { GITHUB_TOKEN: "never-persist-this" },
      authMode: "oauth" as const,
    };
    expect(applyCreateItem(entry, item, false)).toMatchObject({
      status: "setup_required",
      installCfg: { authType: "oauth" },
    });
    entry.draft.auth = {
      type: "oauth",
      issuer: "https://github.com/login/oauth",
      client: "registered",
    };
    const deployment = applyCreateItem(entry, item, false);
    expect(deployment.status).toBe("setup_required");
    expect(deployment.installCfg).toMatchObject({
      authType: "oauth",
      env: {},
      requiredEnv: [],
    });
    expect(JSON.stringify(deployment)).not.toContain(item.values.GITHUB_TOKEN);
  });
});
