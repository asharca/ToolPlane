import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SkillRegistrySync } from "@/components/admin/SkillRegistrySync";

const sync = vi.hoisted(() => vi.fn());
vi.mock("@/lib/admin/market-actions", () => ({
  syncSkillRegistryAction: sync,
}));
vi.mock("@/components/dashboard/SubmitButton", () => ({
  SubmitButton: ({ children }: { children: React.ReactNode }) => (
    <button type="submit">{children}</button>
  ),
}));
const source = {
  owner: "acme",
  repo: "skills",
  ref: "main",
  rootPath: "skills",
  slugPrefix: "acme",
};

describe("registry synchronization failures", () => {
  it("lets an administrator inspect individual failures and retry them", async () => {
    sync
      .mockResolvedValueOnce({
        ok: true,
        found: 3,
        created: 1,
        updated: 0,
        failed: 2,
        source,
        failures: [
          { path: "alpha/SKILL.md", error: "Invalid alpha metadata" },
          { path: "beta/SKILL.md", error: "Invalid beta metadata" },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        found: 2,
        created: 2,
        updated: 0,
        failed: 0,
        source,
        failures: [],
      });
    render(<SkillRegistrySync source={source} />);
    fireEvent.click(screen.getByRole("button", { name: "Sync tp-skills" }));
    expect(
      await screen.findByText("Invalid alpha metadata"),
    ).toBeInTheDocument();
    const betaFile = screen.getAllByRole("treeitem", { name: "SKILL.md" })[1];
    if (!betaFile) throw new Error("Expected beta failure file");
    fireEvent.click(betaFile);
    expect(screen.getByText("Invalid beta metadata")).toBeInTheDocument();
    expect(
      screen.queryByText("Invalid alpha metadata"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry failed/i }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /retry failed/i }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("Invalid beta metadata")).not.toBeInTheDocument();
  });

  it("presents a failed sync without offering a file retry when no files were processed", async () => {
    sync.mockResolvedValueOnce({ error: "Registry repository not found" });
    render(<SkillRegistrySync source={source} />);
    fireEvent.click(screen.getByRole("button", { name: "Sync tp-skills" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Registry repository not found",
    );
    expect(
      screen.queryByRole("button", { name: /retry failed/i }),
    ).not.toBeInTheDocument();
  });
});
