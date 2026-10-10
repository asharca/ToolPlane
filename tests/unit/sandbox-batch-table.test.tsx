import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SandboxBatchTable } from "@/components/dashboard/sandboxes/SandboxBatchTable";
import type { SandboxLifecycleBatchResult } from "@/lib/sandboxes/actions";
import messages from "../../messages/en.json";

const mocks = vi.hoisted(() => ({
  batchSandboxLifecycleAction: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/lib/sandboxes/actions", () => ({
  batchSandboxLifecycleAction: mocks.batchSandboxLifecycleAction,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

const rows = [
  {
    id: "ordinary-sandbox",
    name: "Ordinary sandbox",
    batchEligible: true,
    cells: ["Ordinary sandbox"],
  },
  {
    id: "hermes-sandbox",
    name: "Hermes sandbox",
    batchEligible: true,
    cells: ["Hermes sandbox"],
  },
  {
    id: "blocked-sandbox",
    name: "Blocked sandbox",
    batchEligible: false,
    cells: ["Blocked sandbox"],
  },
];
const headers = [{ label: "Sandbox" }];
const text = messages.console.sandboxes;

function format(template: string, values: Record<string, string | number>) {
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    String(values[key]),
  );
}

function table(visibleRows = rows) {
  return (
    <SandboxBatchTable workspace="acme" headers={headers} rows={visibleRows} />
  );
}

function outcome(
  sandboxId: string,
  result: "success" | "skipped" | "error",
  message: string,
): SandboxLifecycleBatchResult {
  return { sandboxId, outcome: result, message };
}

describe("SandboxBatchTable", () => {
  beforeEach(() => {
    mocks.batchSandboxLifecycleAction.mockReset();
    mocks.refresh.mockReset();
  });

  it("only offers lifecycle actions after selecting visible eligible ordinary and Hermes sandbox ids", async () => {
    const user = userEvent.setup();
    render(table());
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Select all rows" }));
    expect(
      screen.getByRole("toolbar", { name: "2 selected" }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("row", { name: /Blocked sandbox/ })).getByRole(
        "checkbox",
      ),
    ).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Select all eligible (2)" }),
    );
    mocks.batchSandboxLifecycleAction.mockResolvedValue([
      outcome("ordinary-sandbox", "success", "accepted"),
      outcome("hermes-sandbox", "skipped", "already_running"),
    ]);
    await user.click(screen.getByRole("button", { name: "Start selected" }));
    await waitFor(() =>
      expect(mocks.batchSandboxLifecycleAction).toHaveBeenCalledWith(
        "acme",
        "start",
        ["ordinary-sandbox", "hermes-sandbox"],
      ),
    );
    expect(
      await screen.findByText(
        format(text.batchSummary, {
          operation: text.start,
          success: 1,
          skipped: 1,
          error: 0,
        }),
      ),
    ).toBeInTheDocument();
    const resultItems = screen.getAllByRole("listitem");
    expect(resultItems).toHaveLength(2);
    expect(resultItems[0]).toHaveTextContent(rows[0].name);
    expect(resultItems[0]).toHaveTextContent(text.batchOutcome.success);
    expect(resultItems[1]).toHaveTextContent(rows[1].name);
    expect(resultItems[1]).toHaveTextContent(text.batchOutcome.skipped);
    expect(resultItems[1]).toHaveTextContent(text.batchMessage.already_running);
    expect(
      screen.getByRole("heading", { name: text.batchResults }),
    ).toBeInTheDocument();
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("confirms stop and restart, allows cancellation, and freezes all mutations while pending", async () => {
    const user = userEvent.setup();
    let resolveBatch!: (value: SandboxLifecycleBatchResult[]) => void;
    mocks.batchSandboxLifecycleAction.mockImplementation(
      () =>
        new Promise<SandboxLifecycleBatchResult[]>((resolve) => {
          resolveBatch = resolve;
        }),
    );
    render(table());
    await user.click(
      screen.getByRole("button", { name: "Select all eligible (2)" }),
    );
    await user.click(screen.getByRole("button", { name: "Stop selected" }));
    expect(mocks.batchSandboxLifecycleAction).not.toHaveBeenCalled();
    expect(
      screen.getByText(format(text.batchStopPrompt, { count: 2 })),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.batchSandboxLifecycleAction).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Restart selected" }));
    expect(
      screen.getByText(format(text.batchRestartPrompt, { count: 2 })),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(mocks.batchSandboxLifecycleAction).toHaveBeenCalledTimes(1),
    );
    expect(mocks.batchSandboxLifecycleAction).toHaveBeenCalledWith(
      "acme",
      "restart",
      ["ordinary-sandbox", "hermes-sandbox"],
    );
    try {
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Start selected" }),
        ).toBeDisabled(),
      );
      expect(
        screen.getByRole("button", { name: "Clear selection" }),
      ).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Select all eligible (2)" }),
      ).toBeDisabled();
    } finally {
      resolveBatch([
        outcome("ordinary-sandbox", "success", "accepted"),
        outcome("hermes-sandbox", "error", "operation_failed"),
      ]);
    }
    expect(
      await screen.findByText(
        format(text.batchSummary, {
          operation: text.restart,
          success: 1,
          skipped: 0,
          error: 1,
        }),
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")[1]).toHaveTextContent(
      text.batchOutcome.error,
    );
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("reports safe per-item transport failures and refreshes rather than exposing exception details", async () => {
    const user = userEvent.setup();
    mocks.batchSandboxLifecycleAction.mockRejectedValue(
      new Error("SECRET_TOKEN=private"),
    );
    render(table());
    await user.click(
      screen.getByRole("button", { name: "Select all eligible (2)" }),
    );
    await user.click(screen.getByRole("button", { name: "Start selected" }));
    expect(
      await screen.findByText(
        format(text.batchSummary, {
          operation: text.start,
          success: 0,
          skipped: 0,
          error: 2,
        }),
      ),
    ).toBeInTheDocument();
    const resultItems = screen.getAllByRole("listitem");
    expect(resultItems).toHaveLength(2);
    for (const item of resultItems) {
      expect(item).toHaveTextContent(text.batchOutcome.error);
      expect(item).toHaveTextContent(text.batchMessage.request_failed);
    }
    expect(screen.queryByText(/SECRET_TOKEN/)).not.toBeInTheDocument();
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("drops invisible and newly ineligible ids when submitting after a refresh", async () => {
    const user = userEvent.setup();
    const { rerender } = render(table());
    await user.click(
      screen.getByRole("button", { name: "Select all eligible (2)" }),
    );
    rerender(table([rows[1]]));
    expect(
      screen.getByRole("toolbar", { name: "1 selected" }),
    ).toBeInTheDocument();
    mocks.batchSandboxLifecycleAction.mockResolvedValue([
      outcome("hermes-sandbox", "skipped", "not_running"),
    ]);
    await user.click(screen.getByRole("button", { name: "Stop selected" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(mocks.batchSandboxLifecycleAction).toHaveBeenCalledWith(
        "acme",
        "stop",
        ["hermes-sandbox"],
      ),
    );
    expect(
      await screen.findByText(
        format(text.batchSummary, {
          operation: text.stop,
          success: 0,
          skipped: 1,
          error: 0,
        }),
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("listitem")).toHaveTextContent(
      text.batchOutcome.skipped,
    );
    rerender(table([{ ...rows[1], batchEligible: false }]));
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
  });

  it("explicitly limits batches to 100 without silently selecting a subset", async () => {
    const user = userEvent.setup();
    const manyRows = Array.from({ length: 101 }, (_, index) => ({
      id: `sandbox-${index}`,
      name: `Sandbox ${index}`,
      batchEligible: true,
      cells: [`Sandbox ${index}`],
    }));
    render(table(manyRows));
    expect(
      screen.getByRole("button", { name: "Select all eligible (101)" }),
    ).toBeDisabled();
    expect(
      screen.getByText(format(text.batchSelectionLimit, { count: 100 })),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Select all rows" }));
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
    expect(mocks.batchSandboxLifecycleAction).not.toHaveBeenCalled();
  });
});
