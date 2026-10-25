import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentMarketSetupBanner } from "@/components/dashboard/agents/AgentMarketSetupBanner";

describe("AgentMarketSetupBanner", () => {
  it("links provider setup to the agent and each variable to its MCP deployment", () => {
    render(
      <AgentMarketSetupBanner
        slug="acme team"
        setup={{
          missingProviders: [
            { agentId: "subagent/1", format: "openai", model: "gpt-5" },
          ],
          environment: [
            { deploymentId: "deployment/1", variable: "FIRST_API_KEY" },
            { deploymentId: "deployment-2", variable: "SECOND_API_KEY" },
          ],
          runtimes: [{ agentId: "runtime/agent", kind: "hermes" }],
          legacyToolkitConversions: [
            {
              toolkitKey: "toolkit-1",
              name: "Release tools",
              agentIds: ["subagent/1"],
              requiresPrivatePackageConversion: true,
              requiresReauthorization: true,
            },
          ],
        }}
      />,
    );

    expect(
      screen.getByRole("link", { name: /Open agent settings/i }),
    ).toHaveAttribute(
      "href",
      "/app/acme%20team/agents/subagent%2F1?settings=agent",
    );
    const mcpLinks = screen.getAllByRole("link", { name: /Configure MCP/i });
    expect(mcpLinks[0]).toHaveAttribute(
      "href",
      "/app/acme%20team/mcp/deployment%2F1",
    );
    expect(mcpLinks[1]).toHaveAttribute(
      "href",
      "/app/acme%20team/mcp/deployment-2",
    );
    expect(screen.getByRole("link", { name: "New agent" })).toHaveAttribute(
      "href",
      "/app/acme%20team/agents?create=1",
    );
    expect(
      screen.queryByRole("link", { name: /Configure runtime/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/private package and explicitly authorized again/i),
    ).toHaveTextContent("Release tools");
    expect(
      screen.getByRole("link", { name: "Review private packages" }),
    ).toHaveAttribute(
      "href",
      "/app/acme%20team/market/pi-packages?view=toolplane",
    );
  });
});
