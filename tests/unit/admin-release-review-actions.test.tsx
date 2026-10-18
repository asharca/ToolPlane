import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentReleaseReviewActions } from "@/components/admin/AgentReleaseReviewActions";
import { assertDefined } from "../assert-defined";

const actions = vi.hoisted(() => ({ approve: vi.fn(), reject: vi.fn() }));
vi.mock("@/lib/admin/agent-market-actions", () => ({
  approveAgentReleaseAction: actions.approve,
  rejectAgentReleaseAction: actions.reject,
}));
vi.mock("@/components/dashboard/SubmitButton", () => ({
  SubmitButton: ({ children }: { children: React.ReactNode }) => (
    <button type="submit">{children}</button>
  ),
}));
beforeEach(() => {
  actions.approve.mockReset();
  actions.reject.mockReset();
});

describe("immutable agent release moderation", () => {
  it("requires an explicit safety confirmation and submits only selected approval categories", async () => {
    actions.approve.mockResolvedValue({ ok: true });
    render(
      <AgentReleaseReviewActions
        listingId="listing"
        releaseId="release"
        categories={[
          { id: "research", name: "Research" },
          { id: "writing", name: "Writing" },
        ]}
        selectedCategoryIds={["research"]}
      />,
    );
    const button = screen.getByRole("button", { name: "Approve release" });
    const form = assertDefined(button.closest("form"));
    const approval = within(form);
    fireEvent.click(button);
    expect(actions.approve).not.toHaveBeenCalled();
    fireEvent.click(approval.getByRole("checkbox", { name: "Research" }));
    fireEvent.click(approval.getByRole("checkbox", { name: "Writing" }));
    fireEvent.click(
      approval.getByRole("checkbox", { name: /I inspected the complete/ }),
    );
    fireEvent.change(approval.getByRole("textbox", { name: "Review note" }), {
      target: { value: "Inspected all bundled files" },
    });
    fireEvent.click(button);
    expect(await approval.findByRole("status")).toHaveTextContent("Saved");
    const data = actions.approve.mock.calls[0][1] as FormData;
    expect(Object.fromEntries(data)).toMatchObject({
      listingId: "listing",
      releaseId: "release",
      reviewConfirmed: "yes",
      reviewNote: "Inspected all bundled files",
    });
    expect(data.getAll("categoryIds")).toEqual(["writing"]);
    expect(actions.reject).not.toHaveBeenCalled();
  });

  it("does not offer approval when integrity validation disallows it and allows a rejected review to be retried", async () => {
    actions.reject
      .mockResolvedValueOnce({
        error: "The submission changed; reload before reviewing",
      })
      .mockResolvedValue({ ok: true });
    render(
      <AgentReleaseReviewActions
        listingId="listing"
        releaseId="invalid-release"
        allowApprove={false}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Approve release" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    const note = screen.getByRole("textbox", { name: "Review note" });
    fireEvent.change(note, {
      target: { value: "Remove embedded instructions" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reject release" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The submission changed; reload before reviewing",
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Review note" }), {
      target: { value: "Remove embedded instructions" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reject release" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved");
    const data = actions.reject.mock.calls[1][1] as FormData;
    expect(Object.fromEntries(data)).toEqual({
      listingId: "listing",
      releaseId: "invalid-release",
      reviewNote: "Remove embedded instructions",
    });
    expect(actions.approve).not.toHaveBeenCalled();
  });
});
