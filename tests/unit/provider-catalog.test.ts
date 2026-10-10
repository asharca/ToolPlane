import { describe, expect, it, vi } from "vitest";
import { matchingPiModelReferences } from "@/lib/agents/provider-catalog";

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinProviders: () =>
    [
      {
        id: "openai",
        name: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        getModels: () => [
          {
            id: "shared",
            name: "Shared model",
            baseUrl: "https://api.openai.com/v1",
            api: "openai-responses",
            reasoning: true,
            input: ["text"],
            contextWindow: 400_000,
            maxTokens: 128_000,
            cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
          },
          {
            id: "unique",
            name: "Unique model",
            baseUrl: "https://api.openai.com/v1",
            api: "openai-responses",
            reasoning: false,
            input: ["text"],
            contextWindow: 32_000,
            maxTokens: 4096,
            cost: { input: 2, output: 4, cacheRead: 1, cacheWrite: 0 },
          },
        ],
      },
      {
        id: "reseller",
        name: "Reseller",
        getModels: () => [
          {
            id: "shared",
            name: "Shared model",
            baseUrl: "https://reseller.test/v1",
            api: "openai-completions",
            reasoning: true,
            input: ["text"],
            contextWindow: 64_000,
            maxTokens: 8192,
            cost: { input: 3, output: 20, cacheRead: 1, cacheWrite: 0 },
          },
        ],
      },
      {
        id: "minimax-cn",
        name: "MiniMax CN",
        baseUrl: "https://api.minimaxi.com/anthropic",
        getModels: () => [
          {
            id: "minimax-model",
            name: "MiniMax model",
            baseUrl: "https://api.minimaxi.com/anthropic",
            api: "anthropic-messages",
            reasoning: true,
            input: ["text"],
            contextWindow: 204_800,
            maxTokens: 131_072,
            cost: {
              input: 0.3,
              output: 1.2,
              cacheRead: 0.06,
              cacheWrite: 0.375,
            },
          },
        ],
      },
      {
        id: "minimax",
        name: "MiniMax",
        baseUrl: "https://api.minimax.io/anthropic",
        getModels: () => [
          {
            id: "minimax-model",
            name: "MiniMax model",
            baseUrl: "https://api.minimax.io/anthropic",
            api: "anthropic-messages",
            reasoning: true,
            input: ["text"],
            contextWindow: 204_800,
            maxTokens: 131_072,
            cost: {
              input: 0.3,
              output: 1.2,
              cacheRead: 0.06,
              cacheWrite: 0.375,
            },
          },
        ],
      },
    ].reverse(),
}));

describe("provider-scoped metadata source", () => {
  it("uses the Pi provider even if its configured endpoint belongs to another provider", () => {
    expect(
      matchingPiModelReferences(
        "pi:reseller",
        ["shared"],
        "https://api.openai.com/v1",
      ),
    ).toMatchObject([
      {
        providerId: "reseller",
        contextWindow: 64_000,
        cost: { input: 3, output: 20 },
      },
    ]);
    expect(
      matchingPiModelReferences(
        "pi:unknown",
        ["unique"],
        "https://api.openai.com/v1",
      ),
    ).toEqual([]);
  });

  it("uses exact known hosts including model-level endpoints and never crosses their source boundary", () => {
    expect(
      matchingPiModelReferences(
        "openai",
        ["shared"],
        "https://api.openai.com/other/path",
      ),
    ).toMatchObject([{ providerId: "openai", cost: { input: 1.25 } }]);
    expect(
      matchingPiModelReferences(
        "openai",
        ["shared"],
        "https://reseller.test/v1",
      ),
    ).toMatchObject([{ providerId: "reseller", cost: { input: 3 } }]);
    expect(
      matchingPiModelReferences(
        "openai",
        ["unique"],
        "https://reseller.test/v1",
      ),
    ).toEqual([]);
  });

  it.each(["openai", "openai-responses"])(
    "uses the native OpenAI catalog for %s proxies instead of rejecting duplicate vendor entries",
    (format) => {
      expect(
        matchingPiModelReferences(
          format,
          ["shared"],
          "https://unknown.test/v1",
        ),
      ).toMatchObject([
        {
          providerId: "openai",
          contextWindow: 400_000,
          maxOutputTokens: 128_000,
          cost: { input: 1.25, output: 10 },
        },
      ]);
      expect(
        matchingPiModelReferences(
          "openai",
          [" UNIQUE MODEL "],
          "https://unknown.test/v1",
        ),
      ).toMatchObject([{ providerId: "openai", modelId: "unique" }]);
      expect(
        matchingPiModelReferences("openai", ["uni"], "https://unknown.test/v1"),
      ).toEqual([]);
    },
  );

  it("matches duplicate exact model IDs using the configured provider name", () => {
    expect(
      matchingPiModelReferences(
        "openai",
        ["minimax-model"],
        "https://proxy.test/v1",
        "minimax",
      ),
    ).toMatchObject([
      {
        providerId: "minimax",
        modelId: "minimax-model",
        contextWindow: 204_800,
        maxOutputTokens: 131_072,
        cost: { input: 0.3, output: 1.2 },
      },
    ]);
  });

  it("leaves unmatched native-catalog ambiguity unresolved rather than choosing a reseller", () => {
    expect(
      matchingPiModelReferences(
        "anthropic",
        ["shared"],
        "https://unknown.test/v1",
      ),
    ).toEqual([]);
  });

  it("resolves at most one model with exact ID taking precedence over a conflicting display label", () => {
    expect(
      matchingPiModelReferences("pi:openai", ["shared", "Unique model"]),
    ).toMatchObject([{ modelId: "shared" }]);
  });
});
