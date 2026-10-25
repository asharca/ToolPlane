import type { ReactNode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  workspace: vi.fn(),
  agent: vi.fn(),
  listing: vi.fn(),
  assessment: vi.fn(),
  categories: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("next-intl/server", () => ({
  getTranslations:
    async () => (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${Object.values(values).join(",")}` : key,
}));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/workspace/queries", () => ({
  getWorkspaceForUser: mocks.workspace,
}));
vi.mock("@/lib/agents/queries", () => ({ getAgentPageData: mocks.agent }));
vi.mock("@/lib/agents/market", () => ({
  getAgentListingForPublisher: mocks.listing,
  assessAgentPortability: mocks.assessment,
}));
vi.mock("@/lib/db", () => ({
  db: { category: { findMany: mocks.categories } },
}));
vi.mock("@/lib/agents/actions", () => ({
  publishAgentReleaseAction: vi.fn(),
  unpublishAgentListingAction: vi.fn(),
  withdrawPendingAgentReleaseAction: vi.fn(),
}));
vi.mock("@/components/dashboard/SubmitButton", () => ({
  SubmitButton: ({
    children,
    disabled,
  }: {
    children: ReactNode;
    disabled?: boolean;
  }) => (
    <button type="submit" disabled={disabled}>
      {children}
    </button>
  ),
}));

import AgentPublishPage from "@/app/app/[workspace]/agents/[agentId]/publish/page";
import { publishAgentReleaseAction } from "@/lib/agents/actions";

const page = (searchParams = {}) =>
  AgentPublishPage({
    params: Promise.resolve({ workspace: "acme", agentId: "agent-1" }),
    searchParams: Promise.resolve(searchParams),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user.mockResolvedValue({ id: "user-1" });
  mocks.workspace.mockResolvedValue({ id: "ws-1", ownerId: "user-1" });
  mocks.agent.mockResolvedValue({
    id: "agent-1",
    name: "Researcher",
    slug: "researcher",
    runtimeKind: "pi-sdk",
  });
  mocks.listing.mockResolvedValue(null);
  mocks.assessment.mockResolvedValue({
    portable: true,
    manifest: { agents: [{}, {}], deployments: [{}], skills: [], toolkits: [] },
  });
  mocks.categories.mockResolvedValue([
    { id: "cat-1", name: "Research" },
    { id: "cat-2", name: "Writing" },
  ]);
});
afterEach(cleanup);

describe("agent publishing page access and review states", () => {
  it("requires sign-in before loading private agent data", async () => {
    mocks.user.mockResolvedValue(null);
    await expect(page()).rejects.toThrow("redirect:/app/login");
    expect(mocks.agent).not.toHaveBeenCalled();
  });
  it("rejects a workspace inaccessible to the user", async () => {
    mocks.workspace.mockResolvedValue(null);
    await expect(page()).rejects.toThrow("redirect:/app");
    expect(mocks.agent).not.toHaveBeenCalled();
  });
  it("returns notFound for an unknown agent", async () => {
    mocks.agent.mockResolvedValue(null);
    await expect(page()).rejects.toThrow("notFound");
  });
  it.each(["pi-sdk", "pi"])(
    "submits a reviewed %s Agent template through the real publication form",
    async (runtimeKind) => {
      const user = userEvent.setup();
      mocks.agent.mockResolvedValue({
        id: "agent-1",
        name: "SDK agent",
        slug: "sdk-agent",
        runtimeKind,
      });
      render(await page());
      expect(
        screen.getByText("templatePublicationAuthorization"),
      ).toBeInTheDocument();
      await user.type(
        screen.getByLabelText("publicSummary"),
        "Portable research instructions",
      );
      await user.click(screen.getByRole("checkbox", { name: "Research" }));
      await user.click(
        screen.getByRole("checkbox", { name: "confirmPublicContents" }),
      );
      await user.click(screen.getByRole("button", { name: "submitForReview" }));
      await waitFor(() => expect(publishAgentReleaseAction).toHaveBeenCalled());
      const submitted = vi
        .mocked(publishAgentReleaseAction)
        .mock.calls.at(-1)?.[0];
      expect(submitted?.get("workspace")).toBe("acme");
      expect(submitted?.get("agentId")).toBe("agent-1");
      expect(submitted?.get("listingSlug")).toBe("sdk-agent");
      expect(submitted?.get("summary")).toBe("Portable research instructions");
      expect(submitted?.getAll("categoryIds")).toEqual(["cat-1"]);
      expect(submitted?.get("confirmPublicContents")).toBe("yes");
    },
  );
  it("starts an owner draft from agent identity and shows portable resource counts", async () => {
    render(await page());
    expect(screen.getByLabelText("publicName")).toHaveValue("Researcher");
    expect(screen.getByText("subAgents").nextElementSibling).toHaveTextContent(
      "1",
    );
    expect(
      screen.getByRole("button", { name: "submitForReview" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("checkbox", { name: "confirmPublicContents" }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("link", { name: "previewListing" }),
    ).not.toBeInTheDocument();
  });
  it("blocks unsafe releases and presents actual portability issues", async () => {
    mocks.assessment.mockResolvedValue({
      portable: false,
      issues: [
        { message: "Private credentials cannot be exported" },
        { message: "Missing verified MCP source" },
      ],
    });
    render(await page());
    expect(
      screen.getByText("Private credentials cannot be exported"),
    ).toBeInTheDocument();
    expect(screen.getByText("Missing verified MCP source")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "submitForReview" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("checkbox", { name: "confirmPublicContents" }),
    ).toBeDisabled();
  });
  it("allows browsing but prevents members from publishing or withdrawing", async () => {
    mocks.workspace.mockResolvedValue({ id: "ws-1", ownerId: "another-user" });
    mocks.listing.mockResolvedValue({
      pendingRelease: { reviewStatus: "pending", version: 1 },
    });
    render(await page());
    expect(screen.getByRole("alert")).toHaveTextContent("ownerOnlyPublish");
    expect(
      screen.getByRole("button", { name: "submitForReview" }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "withdrawSubmission" }),
    ).not.toBeInTheDocument();
  });
  it("prefills the pending update rather than the published release and exposes owner controls", async () => {
    mocks.listing.mockResolvedValue({
      id: "listing/1",
      slug: "researcher",
      status: "published",
      name: "Published name",
      summary: "Old summary",
      tags: ["old"],
      categoryIds: ["cat-2"],
      latestRelease: { version: 2 },
      pendingRelease: {
        reviewStatus: "pending",
        version: 3,
        name: "Pending name",
        summary: "New summary",
        iconUrl: "https://example.com/icon.png",
        tags: ["fresh", "research"],
        categoryIds: ["cat-1"],
      },
    });
    render(await page({ submitted: "1", unpublished: "1", withdrawn: "1" }));
    expect(screen.getByLabelText("publicName")).toHaveValue("Pending name");
    expect(screen.getByLabelText("publicSummary")).toHaveValue("New summary");
    expect(screen.getByLabelText("marketTags")).toHaveValue("fresh, research");
    expect(screen.getByRole("checkbox", { name: "Research" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Writing" })).not.toBeChecked();
    expect(
      screen.getByRole("link", { name: "previewListing" }),
    ).toHaveAttribute("href", "/app/acme/market/agents/listing%2F1");
    expect(screen.getByText("publishedVersion:2")).toBeInTheDocument();
    expect(screen.getByText("pendingUpdateVersion:3")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "submitUpdateForReview" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "withdrawSubmission" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "unpublish" }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("status").map((node) => node.textContent),
    ).toEqual(["submissionSuccess", "unpublishedSuccess", "withdrawnSuccess"]);
  });
  it.each([
    ["owner_only", "ownerOnlyPublish"],
    ["confirm_required", "confirmRequired"],
    ["invalid_categories", "marketCategoryRequired"],
    ["unknown", "publishError"],
  ])("explains %s publication errors", async (error, message) => {
    render(await page({ error }));
    expect(screen.getByRole("alert")).toHaveTextContent(message);
  });
});
