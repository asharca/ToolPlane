import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResourceEnableForm } from "@/components/dashboard/market/ResourceEnableForm";

const mocks = vi.hoisted(() => ({ preview: vi.fn(), apply: vi.fn() }));
vi.mock("@/lib/agents/actions", () => ({
  previewAgentResourceAction: mocks.preview,
  enableAgentResourceAction: mocks.apply,
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
const agents = [
  { id: "agent-a", name: "Published Pi", published: true },
  { id: "agent-draft", name: "Draft Pi", published: false },
];
const skill = {
  installedSkillId: "resource-a",
  name: "Reviewed skill",
  slug: "reviewed",
  description: null,
  markdown: "# Exact reviewed instructions",
  files: [{ path: "helpers/run.txt", content: "reviewed helper" }],
  checksum: "a".repeat(64),
  userInvocable: true,
  agentInvocable: false,
  effort: "default",
};
const prepared = (kind: "skill" | "mcp" = "skill") => ({
  agentId: "agent-a",
  resourceId: "resource-a",
  resourceKind: kind,
  expectedRevisionId: "revision-current",
  reviewReceipt: "server-signed-review",
  expiresAt: new Date(Date.now() + 900_000).toISOString(),
  sourceChecksum: "a".repeat(64),
  ...(kind === "skill"
    ? { skill }
    : {
        tested: true,
        tools: [{ name: "read", description: "Read only" }, { name: "write" }],
      }),
});
function mount(kind: "skill" | "mcp" = "skill") {
  return render(
    <ResourceEnableForm
      workspace="acme"
      resourceId="resource-a"
      kind={kind}
      agents={agents}
    />,
  );
}
async function waitForControlsIdle() {
  await waitFor(() => {
    expect(screen.getByRole("combobox")).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "resourcePreview" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "resourceApplyRevision" }),
    ).toBeInTheDocument();
  });
}
async function previewSource() {
  fireEvent.click(screen.getByRole("button", { name: "resourcePreview" }));
  await waitForControlsIdle();
}
async function review(kind: "skill" | "mcp" = "skill") {
  mocks.preview.mockResolvedValue(prepared(kind));
  mount(kind);
  fireEvent.change(screen.getByRole("combobox"), {
    target: { value: "agent-a" },
  });
  await previewSource();
  await screen.findByRole("heading", { name: "resourceReviewTitle" });
}
async function approveAndApply() {
  fireEvent.click(
    screen.getByRole("checkbox", { name: "resourceReviewConsent" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "resourceApplyRevision" }),
  );
  await waitForControlsIdle();
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.apply.mockResolvedValue({
    enabled: true,
    agentId: "agent-a",
    revisionId: "revision-published",
  });
});
afterEach(cleanup);

describe("single-resource revision application", () => {
  it("requires a published Agent instead of pretending a draft can be enabled", () => {
    mount();
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "agent-draft" },
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "resourceRevisionPreparationRequired",
    );
    expect(
      screen.getByRole("button", { name: "resourcePreview" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "resourceApplyRevision" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("link", { name: "resourcePrepareRevision" }),
    ).toHaveAttribute("href", "/app/acme/agents/agent-draft");
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("reviews the actual Skill source before applying the signed scoped receipt and CAS revision", async () => {
    await review();
    expect(Object.fromEntries(mocks.preview.mock.calls[0][1])).toEqual({
      workspace: "acme",
      agentId: "agent-a",
      resourceKind: "skill",
      resourceId: "resource-a",
    });
    expect(screen.getByText("# Exact reviewed instructions")).toBeVisible();
    expect(screen.getByText("helpers/run.txt")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "resourceApplyRevision" }),
    ).toBeDisabled();
    expect(mocks.apply).not.toHaveBeenCalled();
    await approveAndApply();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "revision-published",
    );
    expect(Object.fromEntries(mocks.apply.mock.calls[0][1])).toEqual({
      workspace: "acme",
      agentId: "agent-a",
      resourceKind: "skill",
      resourceId: "resource-a",
      expectedRevisionId: "revision-current",
      reviewReceipt: "server-signed-review",
      confirm: "yes",
    });
  });

  it("keeps MCP handshake separate from explicit tool selection and never sends a client catalog", async () => {
    await review("mcp");
    expect(screen.getByRole("checkbox", { name: /read/i })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "write" })).not.toBeChecked();
    expect(mocks.apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: /read/i }));
    await approveAndApply();
    await screen.findByRole("status");
    expect(Object.fromEntries(mocks.apply.mock.calls[0][1])).toEqual({
      workspace: "acme",
      agentId: "agent-a",
      resourceKind: "mcp",
      resourceId: "resource-a",
      expectedRevisionId: "revision-current",
      reviewReceipt: "server-signed-review",
      confirm: "yes",
      allowedToolNames: '["read"]',
    });
  });

  it("preserves reviewed source, selection and consent on a transient refusal and retries explicitly", async () => {
    mocks.apply.mockResolvedValueOnce({ error: "resource_binding_busy" });
    await review("mcp");
    fireEvent.click(screen.getByRole("checkbox", { name: "write" }));
    await approveAndApply();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "resourceBindingBusy",
    );
    expect(screen.getByRole("combobox")).toHaveValue("agent-a");
    expect(screen.getByRole("checkbox", { name: "write" })).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "resourceReviewConsent" }),
    ).toBeChecked();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole("button", { name: "resourceApplyRevision" }),
    );
    await waitForControlsIdle();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "revision-published",
    );
    expect(mocks.apply).toHaveBeenCalledTimes(2);
    expect(mocks.preview).toHaveBeenCalledTimes(1);
  });

  it.each([
    "reviewRequired",
    "reviewExpired",
    "resourceChanged",
    "AGENT_REVISION_CONFLICT",
    "MCP_DEFINITION_CHANGED",
    "MCP_RUNTIME_FILES_CHANGED",
    "MCP_CONNECTION_RESTART_REQUIRED",
    "MCP_DISCOVERY_REQUIRED",
    "MCP_TOOL_SELECTION_CHANGED",
  ])(
    "invalidates %s reviews without discarding choices or retrying automatically",
    async (error) => {
      mocks.apply.mockResolvedValueOnce({ error });
      await review("mcp");
      fireEvent.click(screen.getByRole("checkbox", { name: "write" }));
      await approveAndApply();
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "resourcePreviewExpired",
      );
      expect(screen.getByRole("checkbox", { name: "write" })).toBeChecked();
      expect(
        screen.getByRole("button", { name: "resourceApplyRevision" }),
      ).toBeDisabled();
      expect(mocks.apply).toHaveBeenCalledTimes(1);
      await previewSource();
      await waitFor(() =>
        expect(
          screen.getByRole("checkbox", { name: "write" }),
        ).not.toBeChecked(),
      );
      expect(
        screen.getByRole("checkbox", { name: "resourceReviewConsent" }),
      ).not.toBeChecked();
      expect(
        screen.getByRole("button", { name: "resourceApplyRevision" }),
      ).toBeDisabled();
    },
  );

  it("clears the previous target review and selection when choosing another Agent", async () => {
    await review("mcp");
    fireEvent.click(screen.getByRole("checkbox", { name: "write" }));
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "agent-draft" },
    });
    expect(
      screen.queryByRole("heading", { name: "resourceReviewTitle" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "resourceApplyRevision" }),
    ).toBeDisabled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("refuses expired previews before application", async () => {
    mocks.preview.mockResolvedValue({
      ...prepared(),
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    mount();
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "agent-a" },
    });
    await previewSource();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "resourcePreviewExpired",
    );
    expect(
      screen.getByRole("button", { name: "resourceApplyRevision" }),
    ).toBeDisabled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("never reports a draft-only binding as successful publication", async () => {
    mocks.apply.mockResolvedValue({
      enabled: false,
      bound: true,
      agentId: "agent-a",
    });
    await review();
    await approveAndApply();
    await waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByText(/resourcePublishedRevision/),
    ).not.toBeInTheDocument();
    expect(screen.getByText("# Exact reviewed instructions")).toBeVisible();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "resourceBindingFailed",
    );
  });

  it("rejects a preview scoped to a different target rather than enabling Apply", async () => {
    mocks.preview.mockResolvedValue({
      ...prepared(),
      agentId: "foreign-agent",
    });
    mount();
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "agent-a" },
    });
    await previewSource();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "resourcePreviewFailed",
    );
    expect(
      screen.queryByRole("heading", { name: "resourceReviewTitle" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "resourceApplyRevision" }),
    ).toBeDisabled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });
});
