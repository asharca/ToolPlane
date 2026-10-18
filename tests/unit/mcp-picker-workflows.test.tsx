import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertDefined } from "../assert-defined";
import { McpServerPickerButton } from "@/components/dashboard/McpServerPickerButton";
import { McpResourcePickerButton } from "@/components/dashboard/McpResourcePickerButton";
import { McpPromptPickerButton } from "@/components/dashboard/McpPromptPickerButton";

const resource = {
  kind: "resource",
  id: "file:///guide",
  deploymentId: "docs",
  label: "Guide",
  description: "Project handbook",
};
const prompt = {
  deploymentId: "docs",
  serverName: "Docs",
  name: "summarize",
  title: "Summarize",
  description: "Summarize a topic",
  arguments: [
    {
      name: "topic",
      title: "Topic",
      description: "Your topic",
      required: true,
    },
    { name: "style", required: false },
  ],
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MCP picker workflows", () => {
  it.each([
    McpServerPickerButton,
    McpResourcePickerButton,
    McpPromptPickerButton,
  ])("does not offer unavailable APIs", (Picker) => {
    const { container } = render(
      <Picker disabled={false} onError={vi.fn()} onInsert={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("lists running and unavailable servers, then reloads when reopened", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          items: [
            { id: "a", label: "Docs", status: "running" },
            { id: "b", label: "Search", status: "unavailable" },
          ],
        }),
      )
      .mockResolvedValueOnce(Response.json({ items: null }));
    vi.stubGlobal("fetch", fetcher);
    const changed = vi.fn();
    const view = render(
      <McpServerPickerButton
        apiPath="/mcp?scope=workspace"
        disabled={false}
        open
        onOpenChange={changed}
        hideTrigger
      />,
    );
    expect(await screen.findByText("Docs")).toBeVisible();
    expect(screen.getByText("Search")).toBeVisible();
    expect(fetcher).toHaveBeenCalledWith(
      "/mcp?scope=workspace&section=mcp",
      expect.objectContaining({ cache: "no-store" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(changed).toHaveBeenCalledWith(false);
    view.rerender(
      <McpServerPickerButton apiPath="/mcp" disabled={false} open={false} />,
    );
    view.rerender(
      <McpServerPickerButton apiPath="/mcp" disabled={false} open />,
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByText("Docs")).not.toBeInTheDocument(),
    );
  });

  it.each(["server", "resource", "prompt"] as const)(
    "reports %s API and malformed-response failures",
    async (kind) => {
      const fetcher = vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: "Access denied" }, { status: 403 }),
        );
      vi.stubGlobal("fetch", fetcher);
      const onError = vi.fn();
      const Picker =
        kind === "server"
          ? McpServerPickerButton
          : kind === "resource"
            ? McpResourcePickerButton
            : McpPromptPickerButton;
      render(
        <Picker
          apiPath="/picker"
          disabled={false}
          onError={onError}
          onInsert={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByRole("button"));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Access denied",
      );
      if (kind !== "server")
        expect(onError).toHaveBeenCalledWith("Access denied");
    },
  );

  it.each([
    McpServerPickerButton,
    McpResourcePickerButton,
    McpPromptPickerButton,
  ])("uses localized load errors for non-Error failures", async (Picker) => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("offline"));
    render(
      <Picker
        apiPath="/picker"
        disabled={false}
        open
        hideTrigger
        onError={vi.fn()}
        onInsert={vi.fn()}
      />,
    );
    expect(await screen.findByRole("alert")).not.toHaveTextContent("offline");
  });

  it("filters resources and inserts resolved text rather than an identifier", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          items: [
            resource,
            { ...resource, id: "ignored", kind: "tool" },
            { ...resource, id: "plain", label: "Plain", description: "" },
          ],
        }),
      )
      .mockResolvedValueOnce(Response.json({ text: "Handbook contents" }));
    vi.stubGlobal("fetch", fetcher);
    const onInsert = vi.fn();
    const changed = vi.fn();
    render(
      <McpResourcePickerButton
        apiPath="/resources"
        disabled={false}
        onError={vi.fn()}
        onInsert={onInsert}
        onOpenChange={changed}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(await screen.findByRole("button", { name: /Guide/ }));
    await waitFor(() =>
      expect(onInsert).toHaveBeenCalledWith("Handbook contents"),
    );
    expect(fetcher).toHaveBeenLastCalledWith(
      "/resources",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          kind: "resource",
          id: resource.id,
          deploymentId: "docs",
        }),
      }),
    );
    expect(changed).toHaveBeenLastCalledWith(false);
    expect(screen.queryByText("ignored")).not.toBeInTheDocument();
  });

  it.each([
    Response.json({ error: "Resource gone" }, { status: 404 }),
    Response.json({ text: 42 }),
    new Response("not json", { status: 500 }),
    "disconnected",
  ])(
    "keeps resource selection open after resolution fails",
    async (outcome) => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(Response.json({ items: [resource] }));
      if (typeof outcome === "string") fetcher.mockRejectedValueOnce(outcome);
      else fetcher.mockResolvedValueOnce(outcome);
      vi.stubGlobal("fetch", fetcher);
      const onInsert = vi.fn();
      render(
        <McpResourcePickerButton
          apiPath="/resources?scope=x"
          disabled={false}
          open
          onError={vi.fn()}
          onInsert={onInsert}
        />,
      );
      fireEvent.click(await screen.findByRole("button", { name: /Guide/ }));
      expect(await screen.findByRole("alert")).toBeVisible();
      expect(onInsert).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: /Guide/ })).toBeEnabled();
    },
  );

  it("edits prompt arguments, navigates back, and inserts a resolved prompt", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          prompts: [
            prompt,
            {
              deploymentId: "docs",
              serverName: "Docs",
              name: "simple",
              arguments: [],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(Response.json({ text: "Explain testing" }));
    vi.stubGlobal("fetch", fetcher);
    const onInsert = vi.fn();
    render(
      <McpPromptPickerButton
        apiPath="/prompts"
        disabled={false}
        open
        onError={vi.fn()}
        onInsert={onInsert}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Summarize/ }));
    fireEvent.change(screen.getByLabelText(/Topic/), {
      target: { value: "discarded" },
    });
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    fireEvent.click(screen.getByRole("button", { name: /simple/ }));
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    fireEvent.click(screen.getByRole("button", { name: /Summarize/ }));
    expect(screen.getByLabelText(/Topic/)).toHaveValue("");
    fireEvent.change(screen.getByLabelText(/Topic/), {
      target: { value: "testing" },
    });
    fireEvent.submit(
      assertDefined(screen.getByLabelText(/Topic/).closest("form")),
    );
    await waitFor(() =>
      expect(onInsert).toHaveBeenCalledWith("Explain testing"),
    );
    expect(fetcher).toHaveBeenLastCalledWith(
      "/prompts",
      expect.objectContaining({
        body: JSON.stringify({
          deploymentId: "docs",
          name: "summarize",
          arguments: { topic: "testing", style: "" },
        }),
      }),
    );
  });

  it.each(["http", "invalid", "network"])(
    "reports prompt resolution %s failures without losing arguments",
    async (failure) => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(Response.json({ prompts: [prompt] }));
      if (failure === "network")
        fetcher.mockRejectedValueOnce(new Error("Offline"));
      else
        fetcher.mockResolvedValueOnce(
          failure === "http"
            ? Response.json({ error: "Prompt unavailable" }, { status: 500 })
            : Response.json({}),
        );
      vi.stubGlobal("fetch", fetcher);
      render(
        <McpPromptPickerButton
          apiPath="/prompts"
          disabled={false}
          open
          onError={vi.fn()}
          onInsert={vi.fn()}
        />,
      );
      fireEvent.click(await screen.findByRole("button", { name: /Summarize/ }));
      fireEvent.change(screen.getByLabelText(/Topic/), {
        target: { value: "keep me" },
      });
      fireEvent.submit(
        assertDefined(screen.getByLabelText(/Topic/).closest("form")),
      );
      expect(await screen.findByRole("alert")).toBeVisible();
      expect(screen.getByLabelText(/Topic/)).toHaveValue("keep me");
    },
  );

  it.each([
    McpServerPickerButton,
    McpResourcePickerButton,
    McpPromptPickerButton,
  ])(
    "aborts pending loads on unmount and ignores late failures",
    async (Picker) => {
      const { promise, reject } = Promise.withResolvers<Response>();
      const fetcher = vi.fn((_url: string, _init: RequestInit) => promise);
      vi.stubGlobal("fetch", fetcher);
      const onError = vi.fn();
      const view = render(
        <Picker
          apiPath="/picker"
          disabled={false}
          open
          onError={onError}
          onInsert={vi.fn()}
        />,
      );
      await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
      const signal = fetcher.mock.calls[0]?.[1].signal;
      view.unmount();
      expect(signal?.aborted).toBe(true);
      await act(async () => reject(new Error("late error")));
      expect(onError).not.toHaveBeenCalledWith("late error");
    },
  );
});
