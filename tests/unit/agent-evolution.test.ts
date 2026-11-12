// @vitest-environment node
import { expect, it } from "vitest";
import {
  pareto,
  unsupportedEvaluationTools,
} from "@/lib/agents/evolution/jobs";
import { extractUsage } from "@/lib/agents/evolution/isolation";
import { parseEvolutionPayload } from "@/lib/agents/evolution/schemas";
it("keeps quality and actual model cost as independent Pareto axes", () => {
  expect(pareto({ quality: 1, cost: 2 }, { quality: 1, cost: 1 })).toBe(
    "candidate_dominates",
  );
  expect(pareto({ quality: 1, cost: 1 }, { quality: 0.5, cost: 1 })).toBe(
    "baseline_dominates",
  );
  expect(pareto({ quality: 1, cost: 1 }, { quality: 2, cost: 2 })).toBe(
    "tradeoff",
  );
  expect(pareto({ quality: 1, cost: 1 }, { quality: 1, cost: 1 })).toBe(
    "equal",
  );
});
it("meters streaming provider usage without summing cumulative output twice", () => {
  expect(
    extractUsage(
      'data: {"message":{"usage":{"input_tokens":100,"output_tokens":0,"cache_read_input_tokens":20}}}\n\ndata: {"usage":{"output_tokens":3}}\n\ndata: {"usage":{"output_tokens":8}}\n\ndata: [DONE]\n',
    ),
  ).toEqual({
    inputTokens: 100,
    outputTokens: 8,
    cacheReadTokens: 20,
    cacheWriteTokens: 0,
  });
  expect(
    extractUsage(
      JSON.stringify({ usage: { prompt_tokens: 50, completion_tokens: 10 } }),
    ),
  ).toEqual({
    inputTokens: 50,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  expect(
    extractUsage(
      JSON.stringify({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 30 },
        },
      }),
    ),
  ).toEqual({
    inputTokens: 70,
    outputTokens: 10,
    cacheReadTokens: 30,
    cacheWriteTokens: 0,
  });
  expect(
    extractUsage('data: null\n\ndata: {"usage":{"input_tokens":-1}}\n'),
  ).toEqual({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
});
it("rejects unrecognized persisted payload fields and records actual tool replay fixtures", () => {
  expect(() =>
    parseEvolutionPayload("reflection", {
      baseRevisionId: "revision",
      apiKey: "must not persist",
    }),
  ).toThrow();
  expect(() =>
    parseEvolutionPayload("case", {
      name: "Task",
      input: "Run",
      expected: "Result",
      recordedTools: [
        {
          name: "server_tool",
          description: "Recorded read",
          inputSchema: { type: "object" },
          calls: [
            { arguments: { id: 1 }, result: { answer: 42 }, isError: false },
          ],
        },
      ],
      requiredTools: ["server_tool"],
    }),
  ).not.toThrow();
  expect(() =>
    parseEvolutionPayload("rollout", {
      proposalId: "p",
      evaluationId: "e",
      baselineRevisionId: "b",
      candidateRevisionId: "c",
      percentage: 101,
    }),
  ).toThrow();
  expect(() =>
    parseEvolutionPayload("isolation-container", {
      containerName: "production-agent-container",
      jobId: "job",
      imageId: `sha256:${"a".repeat(64)}`,
    }),
  ).toThrow();
  expect(() =>
    parseEvolutionPayload("reflection", {
      baseRevisionId: "revision",
      checkpoint: {
        episodes: [],
        feedback: [],
        output: { memories: [], proposals: [] },
      },
    }),
  ).not.toThrow();
});

it("accepts required enabled native bash without a recording and rejects disabled or unavailable tools", () => {
  expect(unsupportedEvaluationTools(["bash"], [], [])).toEqual([]);
  expect(unsupportedEvaluationTools(["bash"], [], ["bash"])).toEqual(["bash"]);
  expect(
    unsupportedEvaluationTools(
      ["recorded_lookup"],
      [{ name: "recorded_lookup" }],
      [],
    ),
  ).toEqual([]);
  expect(unsupportedEvaluationTools(["missing_mcp_tool"], [], [])).toEqual([
    "missing_mcp_tool",
  ]);
});
