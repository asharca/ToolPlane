import { describe, expect, it } from "vitest";
import { shouldReportFailureCode } from "@/lib/feedback/classification";
import {
  FEEDBACK_TOOL_NAME,
  ModelFeedbackToolInputSchema,
  SubmitUserFeedbackInputSchema,
} from "@/lib/feedback/types";
import { toolApprovalDecision } from "@/lib/agents/tool-approval-policy";
import {
  piArtifactTool,
  piRuntimeCatalog,
} from "@/lib/agents/execution/runtime-tool-catalog";

describe("feedback failure classification", () => {
  it("reports platform and runtime faults", () => {
    expect(shouldReportFailureCode("PI_EXECUTION_FAILED")).toBe(true);
    expect(shouldReportFailureCode("PI_SDK_RUNTIME_EXITED")).toBe(true);
    expect(shouldReportFailureCode("WORK_SANDBOX_UNAVAILABLE")).toBe(true);
    expect(shouldReportFailureCode("MCP_SANDBOX_UNAVAILABLE")).toBe(true);
  });

  it("ignores cancellations, permission denials, budget limits, and busy states", () => {
    expect(shouldReportFailureCode("PI_SDK_ABORTED")).toBe(false);
    expect(shouldReportFailureCode("MCP_GRANT_REVOKED")).toBe(false);
    expect(shouldReportFailureCode("PI_EXTENSION_RESOURCE_DENIED")).toBe(false);
    expect(shouldReportFailureCode("AGENT_BUDGET_EXCEEDED")).toBe(false);
    expect(shouldReportFailureCode("PI_SANDBOX_BUSY")).toBe(false);
    expect(shouldReportFailureCode("UNKNOWN_CODE")).toBe(false);
  });
});

describe("toolplane_feedback mandatory approval", () => {
  it("always requires user approval regardless of policy mode or overrides", () => {
    expect(toolApprovalDecision(undefined, FEEDBACK_TOOL_NAME)).toBe("ask");
    expect(toolApprovalDecision({ mode: "off" }, FEEDBACK_TOOL_NAME)).toBe(
      "ask",
    );
    expect(
      toolApprovalDecision(
        { mode: "off", overrides: { [FEEDBACK_TOOL_NAME]: "allow" } },
        FEEDBACK_TOOL_NAME,
      ),
    ).toBe("ask");
    expect(
      toolApprovalDecision(
        { mode: "all", overrides: { [FEEDBACK_TOOL_NAME]: "deny" } },
        FEEDBACK_TOOL_NAME,
      ),
    ).toBe("ask");
  });

  it("appends toolplane_feedback to piRuntimeCatalog without shifting base tool indices", () => {
    const catalog = piRuntimeCatalog(false, []);
    expect(catalog[0]?.name).toBe(piArtifactTool.name);
    expect(catalog.at(-1)?.name).toBe(FEEDBACK_TOOL_NAME);
  });
});

describe("feedback schemas", () => {
  it("validates user feedback input with optional conversation snippet", () => {
    const parsed = SubmitUserFeedbackInputSchema.safeParse({
      category: "bug",
      title: "Sandbox failed to start",
      body: "Got a sandbox error during Work execution.",
      includeConversationSnippet: true,
      snippetMessageCount: 6,
    });
    expect(parsed.success).toBe(true);
  });

  it("validates model feedback tool input", () => {
    const parsed = ModelFeedbackToolInputSchema.safeParse({
      category: "failure",
      title: "Runtime tool error",
      body: "Observed repeated failure when preparing sandbox.",
    });
    expect(parsed.success).toBe(true);
  });
});
