import { render, screen, within } from "@testing-library/react";
import { createTranslator } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import messages from "../../messages/en.json";
import { ReleaseChanges } from "@/components/admin/ReleaseChanges";
vi.mock("next-intl/server", () => ({
  getTranslations: async () =>
    createTranslator({ locale: "en", messages, namespace: "adminOps" }),
}));

describe("release configuration comparison", () => {
  it("compares nested configuration values rather than object identities and identifies deleted and new fields", async () => {
    render(
      await ReleaseChanges({
        before: {
          unchanged: { policy: ["read", "write"] },
          removed: { secretReference: "private-key" },
          changed: { allow: ["read"] },
        },
        after: {
          unchanged: { policy: ["read", "write"] },
          added: "new instruction",
          changed: { allow: ["read", "write"] },
        },
      }),
    );
    expect(
      screen.queryByText("unchanged", { selector: "summary" }),
    ).not.toBeInTheDocument();
    for (const key of ["removed", "changed", "added"])
      expect(
        screen.getByText(key, { selector: "summary" }),
      ).toBeInTheDocument();
    const removed = screen.getByText("removed", {
      selector: "summary",
    }).parentElement;
    expect(removed).toHaveTextContent('"secretReference": "private-key"');
    const added = screen.getByText("added", {
      selector: "summary",
    }).parentElement;
    expect(added).toHaveTextContent('"new instruction"');
    expect(added).toHaveTextContent("-");
  });

  it("shows a first release without inventing prior configuration values", async () => {
    render(
      await ReleaseChanges({
        before: null,
        after: { systemPrompt: "Read only" },
      }),
    );
    const current = screen.getByRole("region", {
      name: "Previous approved version",
    });
    expect(within(current).getByText("-")).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Submitted version" }),
    ).toHaveTextContent('"Read only"');
  });

  it.each([
    {
      before: { nested: { allow: ["read"] } },
      after: { nested: { allow: ["read"] } },
    },
    { before: "malformed", after: 42 },
    { before: null, after: null },
  ])(
    "does not report fabricated changes for equal or non-object manifests",
    async ({ before, after }) => {
      const { container } = render(await ReleaseChanges({ before, after }));
      expect(container.querySelector("details")).toBeNull();
      expect(screen.getByText("Unchanged")).toBeInTheDocument();
    },
  );
});
