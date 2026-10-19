import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentListingForm } from "@/components/admin/AgentListingForm";
import { assertDefined } from "../assert-defined";

vi.mock("@/components/dashboard/SubmitButton", () => ({
  SubmitButton: ({ children }: { children: React.ReactNode }) => (
    <button type="submit">{children}</button>
  ),
}));
const servers = [
  { id: "server-a", slug: "server-a", name: "Server A" },
  { id: "server-b", slug: "server-b", name: "Server B" },
];
const skills = [{ id: "skill-a", slug: "skill-a", name: "Skill A" }];

describe("agent directory editor", () => {
  it("submits edited resource selections without changing the published directory identity", () => {
    const { container } = render(
      <AgentListingForm
        action={vi.fn()}
        initial={{
          id: "listing-1",
          directorySlug: "stable",
          name: "Research",
          author: "Acme",
          summary: "Summary",
          iconUrl: "https://example.com/icon",
          tags: ["research", "writing"],
          curated: false,
          isFeatured: true,
          categoryIds: ["category"],
          status: "draft",
          systemPrompt: "Be helpful",
          maxSteps: 20,
          modelFormat: "openai",
          model: "example-model",
          serverIds: ["server-a"],
          skillIds: ["skill-a"],
        }}
        categories={[{ id: "category", name: "Research category" }]}
        servers={servers}
        skills={skills}
        submitLabel="Save"
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Server A" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Server B" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Skill A" }));
    const data = new FormData(assertDefined(container.querySelector("form")));
    expect(data.get("id")).toBe("listing-1");
    expect(data.get("directorySlug")).toBe("stable");
    expect(data.getAll("serverIds")).toEqual(["server-b"]);
    expect(data.getAll("skillIds")).toEqual([]);
    expect(data.get("tags")).toBe("research, writing");
    expect(data.get("updateConfig")).toBe("yes");
    expect(data.get("systemPrompt")).toBe("Be helpful");
  });

  it.each(["agent", "assistant"] as const)(
    "does not submit configuration when editing metadata of a complex %s release",
    (mode) => {
      const { container } = render(
        <AgentListingForm
          action={vi.fn()}
          initial={{
            id: "listing",
            directorySlug: "complex",
            name: "Complex",
            systemPrompt: "Do not replace",
            serverIds: ["server-a"],
          }}
          categories={[]}
          servers={servers}
          skills={skills}
          configEditable={false}
          mode={mode}
          submitLabel="Save"
        />,
      );
      const data = new FormData(assertDefined(container.querySelector("form")));
      expect(data.get("updateConfig")).toBe("no");
      for (const key of [
        "systemPrompt",
        "maxSteps",
        "model",
        "modelFormat",
        "serverIds",
        "skillIds",
      ])
        expect(data.has(key)).toBe(false);
      expect(
        screen.queryByRole("checkbox", { name: "Server A" }),
      ).not.toBeInTheDocument();
    },
  );

  it("does not expose agent skill selection for assistant templates", () => {
    const { container } = render(
      <AgentListingForm
        action={vi.fn()}
        initial={{}}
        categories={[]}
        servers={servers}
        skills={skills}
        mode="assistant"
        submitLabel="Create"
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Server B" }));
    const data = new FormData(assertDefined(container.querySelector("form")));
    expect(data.getAll("serverIds")).toEqual(["server-b"]);
    expect(data.has("skillIds")).toBe(false);
    expect(
      screen.queryByRole("checkbox", { name: "Skill A" }),
    ).not.toBeInTheDocument();
  });

  it("shows save errors without discarding the template prompt", async () => {
    render(
      <AgentListingForm
        action={vi
          .fn()
          .mockResolvedValue({ error: "Directory slug already exists" })}
        initial={{
          name: "Research",
          directorySlug: "research",
          systemPrompt: "Retain me",
        }}
        categories={[]}
        servers={[]}
        skills={[]}
        submitLabel="Create"
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("research-assistant"), {
      target: { value: "research" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Directory slug already exists",
    );
    expect(screen.getByDisplayValue("Retain me")).toBeInTheDocument();
  });
});
