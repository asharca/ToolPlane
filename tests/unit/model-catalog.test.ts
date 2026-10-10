import { describe, expect, it } from "vitest";
import {
  defaultProviderModel,
  fillProviderModelMetadata,
  inferModelGroup,
  inferModelPrimaryType,
  type PiModelReference,
} from "@/lib/agents/model-catalog";
import { matchingPiModelReferences } from "@/lib/agents/provider-catalog";

describe("provider model catalog defaults", () => {
  it("derives Cherry-style groups and safe initial model types", () => {
    expect(inferModelGroup("openai/gpt-5.5")).toBe("openai");
    expect(inferModelGroup("deepseek-v4-pro")).toBe("deepseek");
    expect(inferModelPrimaryType("text-embedding-3-large")).toBe("embedding");
    expect(inferModelPrimaryType("bge-reranker-v2")).toBe("rerank");
    expect(inferModelPrimaryType("gpt-image-1")).toBe("image");
    expect(defaultProviderModel("claude-sonnet-4")).toMatchObject({
      name: "claude-sonnet-4",
      group: "claude",
      primaryType: "text",
    });
  });
});

const reference: PiModelReference = {
  providerId: "openai",
  providerName: "OpenAI",
  modelId: "gpt-5",
  name: "GPT-5",
  api: "openai-responses",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 400_000,
  maxOutputTokens: 128_000,
  cost: {
    input: 1.25,
    output: 10,
    cacheRead: 0.125,
    cacheWrite: 0,
    tiers: [
      {
        inputTokensAbove: 200_000,
        input: 2.5,
        output: 15,
        cacheRead: 0.25,
        cacheWrite: 0,
      },
    ],
  },
};

describe("owned provider model metadata", () => {
  it("fills missing catalog metadata including full price tiers without inventing input-only limits", () => {
    const model = {
      ...defaultProviderModel("local-alias"),
      name: "",
      group: "",
    };
    const filled = fillProviderModelMetadata(model, reference);
    expect(filled).toMatchObject({
      modelId: "local-alias",
      name: "GPT-5",
      group: "gpt",
      contextWindow: 400_000,
      maxInputTokens: null,
      maxOutputTokens: 128_000,
      capabilities: ["reasoning"],
      inputModalities: ["image"],
      cost: reference.cost,
    });
    expect(model).toMatchObject({ contextWindow: null, cost: null, name: "" });
  });

  it("retains manual labels, classification, explicit limits and zero-price overrides", () => {
    const model = {
      ...defaultProviderModel("gpt-5"),
      name: "My model",
      group: "Private",
      primaryType: "embedding" as const,
      capabilities: ["function_calling" as const],
      inputModalities: ["audio" as const],
      contextWindow: 8192,
      maxInputTokens: 4096,
      maxOutputTokens: 2048,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    expect(fillProviderModelMetadata(model, reference)).toEqual(model);
    expect(fillProviderModelMetadata(model, null)).toBe(model);
  });

  it("fills GPT-6 Sol from the current native catalog with its pricing tiers instead of a reseller or an empty result", () => {
    const [reference] = matchingPiModelReferences(
      "openai-responses",
      ["gpt-6-sol"],
      "https://proxy.test/v1",
    );
    expect(reference?.providerId).toBe("openai");
    expect(
      fillProviderModelMetadata(
        defaultProviderModel("gpt-6-sol"),
        reference ?? null,
      ),
    ).toMatchObject({
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      capabilities: ["reasoning"],
      inputModalities: ["image"],
      cost: {
        input: 2,
        output: 10,
        cacheRead: 0.2,
        cacheWrite: 2.5,
        tiers: [
          {
            inputTokensAbove: 272_000,
            input: 4,
            output: 15,
            cacheRead: 0.4,
            cacheWrite: 5,
          },
        ],
      },
    });
  });

  it.each(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"])(
    "imports %s maximum context independently of its pricing threshold",
    (modelId) => {
      const [reference] = matchingPiModelReferences("pi:openai", [modelId]);
      const filled = fillProviderModelMetadata(
        defaultProviderModel(modelId),
        reference,
      );
      expect(filled.contextWindow).toBe(1_050_000);
      expect(filled.cost?.tiers?.[0].inputTokensAbove).toBe(272_000);
      expect(
        fillProviderModelMetadata(
          { ...filled, contextWindow: 64_000 },
          reference,
        ).contextWindow,
      ).toBe(64_000);
    },
  );
});
