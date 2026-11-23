// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  providerFindFirst: vi.fn(),
  providerCreate: vi.fn(),
  providerUpdate: vi.fn(),
  providerUpdateMany: vi.fn(),
  workspaceFindFirst: vi.fn(),
  queryRaw: vi.fn(),
  transaction: vi.fn(),
  refreshProviderModels: vi.fn(),
  revalidateProviderViews: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mocks.transaction,
    modelProvider: {
      findFirst: mocks.providerFindFirst,
      create: mocks.providerCreate,
      update: mocks.providerUpdate,
      updateMany: mocks.providerUpdateMany,
    },
    workspace: {
      findFirst: mocks.workspaceFindFirst,
    },
  },
}));

vi.mock("@/lib/observability/audit", () => ({
  writeAudit: vi.fn(),
}));

vi.mock("@/lib/agents/provider-model-refresh", () => ({
  refreshProviderModels: mocks.refreshProviderModels,
  revalidateProviderViews: mocks.revalidateProviderViews,
}));

import {
  parseProviderCredential,
  providerAuthType,
  providerSecrets,
  serializeProviderCredential,
} from "@/lib/agents/provider-credentials";
import { piProviderPresets } from "@/lib/agents/provider-catalog";
import { agentRuntimeSupportsProviderFormat } from "@/lib/agents/runtime-kind";
import { piProviderProtocol } from "@/lib/agents/sandbox-runtime";
import { buildModel, providerModelIds } from "@/lib/agents/model";
import {
  cancelProviderOAuthSession,
  ProviderOAuthError,
  startProviderOAuthSession,
  workspaceOAuthDeviceId,
} from "@/lib/agents/provider-oauth";
import { resolveWorkspaceScope } from "@/lib/workspace/scope";

describe("provider credentials and OAuth support", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        $queryRaw: mocks.queryRaw,
        workspace: { findFirst: mocks.workspaceFindFirst },
        modelProvider: {
          findFirst: mocks.providerFindFirst,
          create: mocks.providerCreate,
          update: mocks.providerUpdate,
          updateMany: mocks.providerUpdateMany,
        },
      }),
    );
    mocks.refreshProviderModels.mockResolvedValue(null);
  });

  it("parses and serializes plain API keys and OAuth credentials", () => {
    expect(parseProviderCredential("  sk-test-123  ")).toEqual({
      type: "api_key",
      key: "sk-test-123",
    });
    expect(providerAuthType("sk-test-123")).toBe("api_key");
    expect(providerAuthType("   ")).toBe("none");
    expect(
      serializeProviderCredential({ type: "api_key", key: "sk-test-123" }),
    ).toBe("sk-test-123");

    const oauthRaw = serializeProviderCredential({
      type: "oauth",
      access: "access-token-xyz",
      refresh: "refresh-token-abc",
      expires: 1_900_000_000_000,
    });
    expect(providerAuthType(oauthRaw)).toBe("oauth");
    expect(parseProviderCredential(oauthRaw)).toEqual({
      type: "oauth",
      access: "access-token-xyz",
      refresh: "refresh-token-abc",
      expires: 1_900_000_000_000,
    });

    const secrets = providerSecrets(oauthRaw);
    expect(secrets).toContain(oauthRaw);
    expect(secrets).toContain("access-token-xyz");
    expect(secrets).toContain("refresh-token-abc");
  });

  it("exposes OAuth login metadata on built-in provider presets", () => {
    const presets = piProviderPresets();
    const anthropic = presets.find((p) => p.format === "pi:anthropic");
    expect(anthropic?.authModes).toEqual(["oauth", "api_key"]);
    expect(anthropic?.oauthMethods?.map((m) => m.id)).toEqual([
      "browser",
      "copy_code",
    ]);

    const codex = presets.find((p) => p.format === "pi:openai-codex");
    expect(codex?.authModes).toEqual(["oauth"]);
    expect(codex?.oauthMethods?.map((m) => m.id)).toEqual([
      "browser",
      "device_code",
    ]);

    const copilot = presets.find((p) => p.format === "pi:github-copilot");
    expect(copilot?.authModes).toEqual(["oauth", "api_key"]);
    expect(copilot?.supportsEnterpriseDomain).toBe(true);
  });

  it("supports both custom and built-in pi:* provider formats in Pi runtime", () => {
    for (const format of [
      "openai",
      "openai-responses",
      "anthropic",
      "pi:openai",
      "pi:anthropic",
      "pi:openai-codex",
      "pi:github-copilot",
      "pi:openrouter",
    ]) {
      expect(agentRuntimeSupportsProviderFormat("pi-sdk", format)).toBe(true);
    }
    expect(piProviderProtocol("openai")).toBe("openai-completions");
    expect(piProviderProtocol("openai-responses")).toBe("openai-responses");
    expect(piProviderProtocol("anthropic")).toBe("anthropic-messages");
    expect(piProviderProtocol("pi:openai")).toBe("anthropic-messages");
    expect(piProviderProtocol("pi:openai-codex")).toBe("anthropic-messages");
  });

  it("filters GitHub Copilot models when an OAuth credential specifies availableModelIds", () => {
    const allCopilotModels = providerModelIds({
      name: "Copilot",
      format: "pi:github-copilot",
      baseUrl: "",
      apiKey: "plain-token",
    });
    expect(allCopilotModels?.length).toBeGreaterThan(1);
    const firstModel = allCopilotModels?.[0] ?? "gpt-4o";

    const filteredModels = providerModelIds({
      name: "Copilot",
      format: "pi:github-copilot",
      baseUrl: "",
      apiKey: JSON.stringify({
        type: "oauth",
        access:
          "tid=1;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com",
        refresh: "gho_refresh",
        expires: Date.now() + 3_600_000,
        availableModelIds: [firstModel],
      }),
    });
    expect(filteredModels).toEqual([firstModel]);
  });

  it("resolves OAuth credentials in buildModel for built-in OAuth providers", async () => {
    const expires = Date.now() + 3_600_000;
    const provider = {
      id: "prov-1",
      name: "Anthropic Pro",
      format: "pi:anthropic",
      baseUrl: "",
      apiKey: JSON.stringify({
        type: "oauth",
        access: "claude-oauth-access-token",
        refresh: "claude-oauth-refresh-token",
        expires,
      }),
    };
    const { models, model } = buildModel(provider, "claude-sonnet-4-6");
    const auth = await models.getAuth(model);
    expect(auth).toMatchObject({
      source: "OAuth",
      auth: { apiKey: "claude-oauth-access-token" },
    });
  });

  it("validates workspace name uniqueness and starts an interactive OAuth session", async () => {
    mocks.workspaceFindFirst.mockResolvedValue({
      id: "ws-1",
      slug: "smoke",
      name: "Smoke",
      ownerId: "user-1",
      members: [],
    });
    const scope = await resolveWorkspaceScope(
      { id: "ws-1" },
      "user-1",
      "resources",
    );
    if (!scope) throw new Error("Expected workspace scope");

    expect(workspaceOAuthDeviceId("ws-1")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    mocks.providerFindFirst.mockResolvedValueOnce({ id: "existing-id" });
    await expect(
      startProviderOAuthSession({
        scope,
        userId: "user-1",
        format: "pi:anthropic",
        name: "Anthropic",
        loginMethod: "copy_code",
      }),
    ).rejects.toBeInstanceOf(ProviderOAuthError);

    mocks.providerFindFirst.mockResolvedValueOnce(null);
    const snapshot = await startProviderOAuthSession({
      scope,
      userId: "user-1",
      format: "pi:anthropic",
      name: "Anthropic Claude",
      loginMethod: "copy_code",
    });

    expect(snapshot.status).toBe("waiting");
    expect(snapshot.authUrl?.url).toContain(
      "https://claude.ai/oauth/authorize",
    );
    expect(snapshot.prompt?.type).toBe("manual_code");

    const cancelled = cancelProviderOAuthSession({
      workspaceId: "ws-1",
      userId: "user-1",
      sessionId: snapshot.sessionId,
    });
    expect(cancelled.status).toBe("cancelled");
  });
});
