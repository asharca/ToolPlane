import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentModelDialog } from "@/components/dashboard/agents/AgentModelDialog";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
const actions = vi.hoisted(() => ({
  updateAgentModelAction: vi.fn(async () => ({ savedAt: Date.now() })),
}));
vi.mock("@/lib/agents/actions", () => actions);

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("AgentModelDialog", () => {
  it("uses the shared runtime compatibility rule for the Work model picker", () => {
    render(
      <AgentModelDialog
        open
        onOpenChange={vi.fn()}
        slug="acme"
        agent={{
          id: "agent-1",
          name: "Claude worker",
          runtimeKind: "claude-code",
          providerId: null,
          providerIds: [],
          model: null,
        }}
        providers={[
          {
            id: "responses",
            name: "Responses",
            format: "openai-responses",
            models: ["gpt-5.6-luna"],
          },
          {
            id: "pi-native",
            name: "Pi native",
            format: "pi:openai",
            models: ["gpt-native"],
          },
        ]}
        trigger={<button type="button">Model</button>}
      />,
    );

    expect(screen.getByText("gpt-5.6-luna")).toBeInTheDocument();
    expect(screen.queryByText("gpt-native")).not.toBeInTheDocument();
  });
});
