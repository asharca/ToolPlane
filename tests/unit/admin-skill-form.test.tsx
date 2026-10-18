import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SkillForm } from "@/components/admin/SkillForm";
import { assertDefined } from "../assert-defined";

vi.mock("@/components/dashboard/SubmitButton", () => ({
  SubmitButton: ({ children }: { children: React.ReactNode }) => (
    <button type="submit">{children}</button>
  ),
}));

describe("skill editor", () => {
  it("keeps the existing slug immutable while allowing categories to be changed", () => {
    const { container } = render(
      <SkillForm
        action={vi.fn()}
        initial={{
          id: "skill-1",
          slug: "stable-slug",
          name: "A skill",
          categoryIds: ["a"],
          score: 5,
          author: "Author",
          description: "Description",
          iconUrl: "https://example.com/icon.svg",
          githubSource: "acme/repo",
        }}
        categories={[
          { id: "a", name: "Alpha" },
          { id: "b", name: "Beta" },
        ]}
        submitLabel="Save"
      />,
    );
    expect(
      screen.queryByRole("textbox", { name: /slug/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("stable-slug")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Alpha" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Beta" }));
    const data = new FormData(assertDefined(container.querySelector("form")));
    expect(data.get("id")).toBe("skill-1");
    expect(data.has("slug")).toBe(false);
    expect(data.getAll("categoryIds")).toEqual(["b"]);
    expect(data.get("githubSource")).toBe("acme/repo");
  });

  it("collects a new skill identity without submitting an existing ID", () => {
    const { container } = render(
      <SkillForm
        action={vi.fn()}
        initial={{}}
        categories={[]}
        submitLabel="Create"
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "New skill" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /slug/i }), {
      target: { value: "new-skill" },
    });
    const data = new FormData(assertDefined(container.querySelector("form")));
    expect(data.get("name")).toBe("New skill");
    expect(data.get("slug")).toBe("new-skill");
    expect(data.has("id")).toBe(false);
  });

  it("shows a rejected save while retaining the user's entered identity", async () => {
    render(
      <SkillForm
        action={vi.fn().mockResolvedValue({ error: "Slug already exists" })}
        initial={{ name: "My skill", slug: "my-skill" }}
        categories={[]}
        submitLabel="Create"
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: /slug/i }), {
      target: { value: "my-skill" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Slug already exists",
    );
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
      "My skill",
    );
  });
});
