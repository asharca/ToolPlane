import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { McpConnectionFlow } from "@/components/dashboard/McpConnectionFlow";

const mocks = vi.hoisted(() => ({
  discover: vi.fn(),
  inspector: vi.fn(),
  preview: vi.fn(),
  apply: vi.fn(),
  refresh: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));
vi.mock("@/lib/workspace/actions", () => ({
  discoverMcpConnectionAction: mocks.discover,
}));
vi.mock("@/lib/workspace/inspector-actions", () => ({
  connectMcpInspectorAction: mocks.inspector,
}));
vi.mock("@/lib/agents/actions", () => ({
  previewAgentResourceAction: mocks.preview,
  enableAgentResourceAction: mocks.apply,
}));

const assistant = {
  kind: "assistant" as const,
  id: "assistant-a",
  name: "Reader",
  revision: 4,
  grants: [{ deploymentId: "other", allowedToolNames: ["keep"] }],
};
const reviewedChecksum = "a".repeat(64);

describe("McpConnectionFlow", () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.discover.mockResolvedValue({
      definitionChecksum: reviewedChecksum,
      tools: [{ name: "read" }, { name: "write" }],
    });
    mocks.inspector.mockResolvedValue({
      definitionChecksum: reviewedChecksum,
      tools: [{ name: "read" }],
    });
    mocks.preview.mockResolvedValue({
      agentId: "agent-a",
      resourceId: "connection-a",
      resourceKind: "mcp",
      expectedRevisionId: "revision-reviewed",
      reviewReceipt: "server-scoped-receipt",
      sourceChecksum: reviewedChecksum,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      tested: true,
      tools: [{ name: "read" }],
    });
    mocks.apply.mockResolvedValue({
      enabled: true,
      agentId: "agent-a",
      revisionId: "revision-new",
    });
    mocks.fetch.mockResolvedValue({ ok: true });
  });

  it("separates protocol discovery from explicit Assistant authorization and preserves unrelated grants", async () => {
    render(
      <McpConnectionFlow
        workspace="acme"
        deploymentId="connection-a"
        targets={[assistant]}
      />,
    );
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "assistant:assistant-a" },
    });
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "discoverConnection" }));
    const read = await screen.findByRole("checkbox", { name: "read" });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "discoverConnection" }),
      ).toBeEnabled(),
    );
    expect(read).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "write" })).not.toBeChecked();
    expect(mocks.fetch).not.toHaveBeenCalled();
    fireEvent.click(read);
    fireEvent.click(screen.getByRole("button", { name: "applyConnection" }));
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    const [, options] = mocks.fetch.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({
      expectedRevision: 4,
      mcpGrants: [
        { deploymentId: "other", allowedToolNames: ["keep"] },
        {
          deploymentId: "connection-a",
          allowedToolNames: ["read"],
          expectedDefinitionChecksum: reviewedChecksum,
        },
      ],
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "connectionApplied",
    );
  });

  it("uses scoped source preview for a stopped stdio connection and invalidates a conflicting receipt without losing choices", async () => {
    mocks.apply.mockResolvedValue({ error: "AGENT_REVISION_CONFLICT" });
    render(
      <McpConnectionFlow
        workspace="acme"
        deploymentId="connection-a"
        targets={[
          { kind: "agent", id: "agent-a", name: "Worker", published: true },
        ]}
      />,
    );
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "agent:agent-a" },
    });
    fireEvent.click(screen.getByRole("button", { name: "resourcePreview" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "resourcePreview" }),
      ).toBeEnabled(),
    );
    expect(Object.fromEntries(mocks.preview.mock.calls[0][1])).toEqual({
      workspace: "acme",
      agentId: "agent-a",
      resourceKind: "mcp",
      resourceId: "connection-a",
    });
    expect(mocks.inspector).not.toHaveBeenCalled();
    expect(mocks.discover).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: "read" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "read" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "resourceReviewConsent" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "resourceApplyRevision" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "resourcePreviewExpired",
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "resourcePreview" }),
      ).toBeEnabled(),
    );
    expect(screen.getByRole("checkbox", { name: "read" })).toBeChecked();
    expect(
      screen.getByRole("button", { name: "resourceApplyRevision" }),
    ).toBeDisabled();
    expect(Object.fromEntries(mocks.apply.mock.calls[0][1])).toEqual({
      workspace: "acme",
      agentId: "agent-a",
      resourceKind: "mcp",
      resourceId: "connection-a",
      expectedRevisionId: "revision-reviewed",
      reviewReceipt: "server-scoped-receipt",
      confirm: "yes",
      allowedToolNames: '["read"]',
    });
    expect(screen.queryByText("connectionApplied")).not.toBeInTheDocument();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("shows the actual published Agent revision only after successful receipt application", async () => {
    render(
      <McpConnectionFlow
        workspace="acme"
        deploymentId="connection-a"
        targets={[
          { kind: "agent", id: "agent-a", name: "Worker", published: true },
        ]}
      />,
    );
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "agent:agent-a" },
    });
    fireEvent.click(screen.getByRole("button", { name: "resourcePreview" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "resourcePreview" }),
      ).toBeEnabled(),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "resourceReviewConsent" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "resourceApplyRevision" }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("revision-new");
    expect(mocks.apply.mock.calls[0][1].get("allowedToolNames")).toBe("[]");
    expect(mocks.inspector).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("offers revision preparation instead of inspecting an unpublished Agent template", () => {
    render(
      <McpConnectionFlow
        workspace="acme"
        deploymentId="connection-a"
        targets={[
          { kind: "agent", id: "agent-draft", name: "Draft", published: false },
        ]}
      />,
    );
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "agent:agent-draft" },
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "resourceRevisionPreparationRequired",
    );
    expect(
      screen.getByRole("button", { name: "resourcePreview" }),
    ).toBeDisabled();
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.inspector).not.toHaveBeenCalled();
  });

  it("does not offer authorization without a checksum-bound discovery result", async () => {
    mocks.discover.mockResolvedValue({ tools: [{ name: "read" }] });
    render(
      <McpConnectionFlow
        workspace="acme"
        deploymentId="connection-a"
        targets={[assistant]}
      />,
    );
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "assistant:assistant-a" },
    });
    fireEvent.click(screen.getByRole("button", { name: "discoverConnection" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "connectionDiscoveryFailed",
    );
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "applyConnection" }),
    ).not.toBeInTheDocument();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
