import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createTranslator } from "next-intl";
import messages from "../../messages/en.json";
import { AgentReleaseReview } from "@/components/admin/AgentReleaseReview";

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: "admin" | "adminOps") =>
    createTranslator({ locale: "en", messages, namespace }),
}));
vi.mock("@/lib/admin/agent-market-actions", () => ({
  approveAgentReleaseAction: vi.fn(),
  rejectAgentReleaseAction: vi.fn(),
}));
const snapshot = {
  id: "release/one",
  version: 3,
  name: "Research snapshot",
  summary: "A reviewed immutable release",
  iconUrl: null,
  tags: [],
  checksum: "abc123",
  publishedAt: "2026-10-01T00:00:00Z",
  categoryIds: [],
  reviewStatus: "pending",
  reviewNote: null,
  reviewedAt: null,
  reviewedBy: null,
  manifest: {
    rootAgentKey: "root",
    agents: [
      {
        key: "root",
        name: "Research root",
        systemPrompt: "Root instructions",
        modelRequirement: { format: "openai", model: "research-model" },
      },
      {
        key: "child",
        name: "Research child",
        systemPrompt: null,
        modelRequirement: null,
      },
    ],
    deployments: [
      { key: "server", name: "Verified server", catalogSlug: "verified" },
    ],
    skills: [{ key: "skill", name: "Custom skill", origin: "custom" }],
    toolkits: [{ key: "toolkit", name: "Research tools" }],
  },
};

describe("agent release audit presentation", () => {
  it("exposes all agent instructions and the complete immutable artifact before approval", async () => {
    render(
      await AgentReleaseReview({
        listingId: "listing",
        release: snapshot,
        categories: [],
      }),
    );
    expect(screen.getByText("Root instructions")).toBeInTheDocument();
    expect(
      screen.getByText("No system prompt is defined."),
    ).toBeInTheDocument();
    expect(screen.getByText("openai / research-model")).toBeInTheDocument();
    expect(screen.getByText("Verified server")).toBeInTheDocument();
    expect(screen.getByText("Custom skill")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open complete manifest" }),
    ).toHaveAttribute(
      "href",
      "/api/v1/admin/agent-releases/release%2Fone/manifest",
    );
    expect(
      screen.getByRole("button", { name: "Approve release" }),
    ).toBeInTheDocument();
  });

  it("bounds prompt previews while retaining the complete artifact link", async () => {
    const prefix = "Safe instructions.".repeat(1200);
    const tail = "SECRET-END-OF-VERY-LONG-PROMPT";
    render(
      await AgentReleaseReview({
        listingId: "listing",
        release: {
          ...snapshot,
          summary: null,
          manifest: {
            ...snapshot.manifest,
            deployments: [],
            skills: [],
            agents: [
              { ...snapshot.manifest.agents[0], systemPrompt: prefix + tail },
            ],
          },
        },
        categories: [],
      }),
    );
    const preview = screen.getByText(
      /Preview truncated — inspect the complete manifest/,
    );
    expect(preview.textContent).toBe(
      `${prefix.slice(0, 20000)}\n\n[Preview truncated — inspect the complete manifest before approval.]`,
    );
    expect(preview.textContent).not.toContain(tail);
    expect(
      screen.getByRole("link", { name: "Open complete manifest" }),
    ).toBeInTheDocument();
  });

  it.each([
    {
      status: "approved",
      reviewer: { name: "Reviewer Name", email: "reviewer@example.invalid" },
      expected: "Reviewer Name",
      note: "Reviewed all resources",
      date: "2026-10-02T00:00:00Z",
    },
    {
      status: "rejected",
      reviewer: { name: null, email: "reviewer@example.invalid" },
      expected: "reviewer@example.invalid",
      note: null,
      date: null,
    },
    {
      status: "external_status",
      reviewer: null,
      expected: "-",
      note: null,
      date: null,
    },
  ])(
    "makes $status audits read-only and identifies the reviewer",
    async ({ status, reviewer, expected, note, date }) => {
      render(
        await AgentReleaseReview({
          listingId: "listing",
          canReview: false,
          categories: [],
          release: {
            ...snapshot,
            reviewStatus: status,
            reviewedBy: reviewer,
            reviewNote: note,
            reviewedAt: date,
            manifest: {
              ...snapshot.manifest,
              rootAgentKey: "missing-root",
              agents: [],
              deployments: [],
            },
          },
        }),
      );
      expect(
        screen.queryByRole("button", { name: /release/i }),
      ).not.toBeInTheDocument();
      expect(screen.getByText("No model requirement")).toBeInTheDocument();
      expect(screen.getAllByText(expected).length).toBeGreaterThanOrEqual(1);
      if (note) expect(screen.getByText(note)).toBeInTheDocument();
      if (status === "external_status")
        expect(screen.getByText(status)).toBeInTheDocument();
    },
  );
});
