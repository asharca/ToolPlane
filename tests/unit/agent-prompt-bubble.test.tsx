import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PromptInput } from "@/components/agents/prompt-input";
import {
  MessageBubble,
  MessageBubbleCollapsible,
  MessageBubbleContent,
} from "@/components/agents/message-bubble";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("agent prompt submission boundaries", () => {
  it("trims an uncontrolled prompt, submits the selected model, clears text and restores focus", () => {
    const submit = vi.fn();
    render(
      <PromptInput
        defaultValue="  Explain this code  "
        models={[{ value: "small", label: "Small model" }]}
        onSubmit={submit}
      />,
    );
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Prompt" }), {
      key: "Enter",
    });
    expect(submit).toHaveBeenCalledWith("Explain this code", "small");
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(screen.getByRole("textbox")).toHaveFocus();
    expect(screen.getByRole("button", { name: "Send prompt" })).toBeDisabled();
  });

  it.each([
    { key: "Enter", shiftKey: true },
    { key: "Enter", isComposing: true },
    { key: "Enter", keyCode: 229 },
    { key: "a" },
  ])("does not send for a non-submitting key event %j", (event) => {
    const submit = vi.fn();
    render(<PromptInput defaultValue="Keep drafting" onSubmit={submit} />);
    fireEvent.keyDown(screen.getByRole("textbox"), event);
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue("Keep drafting");
  });

  it("honors a consumer-cancelled Enter and controlled value updates without clearing owner state", () => {
    const submit = vi.fn(),
      change = vi.fn();
    const { rerender } = render(
      <PromptInput
        value="Owned text"
        onValueChange={change}
        onSubmit={submit}
        onKeyDown={(event) => event.preventDefault()}
      />,
    );
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(submit).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "New draft" },
    });
    expect(change).toHaveBeenCalledWith("New draft");
    expect(screen.getByRole("textbox")).toHaveValue("Owned text");
    rerender(<PromptInput value="New draft" onSubmit={submit} />);
    fireEvent.click(screen.getByRole("button", { name: "Send prompt" }));
    expect(submit).toHaveBeenCalledWith("New draft", undefined);
    expect(screen.getByRole("textbox")).toHaveValue("New draft");
  });

  it.each(["disabled", "loading", "blank"])(
    "rejects form and keyboard submissions while %s",
    (mode) => {
      const submit = vi.fn();
      render(
        <PromptInput
          defaultValue={mode === "blank" ? "   " : "Draft"}
          disabled={mode === "disabled"}
          loading={mode === "loading"}
          onSubmit={submit}
        />,
      );
      const textbox = screen.getByRole("textbox");
      fireEvent.keyDown(textbox, { key: "Enter" });
      fireEvent.submit(textbox.closest("form") as HTMLFormElement);
      expect(submit).not.toHaveBeenCalled();
    },
  );

  it("offers cancellation during generation only when a stop handler exists", () => {
    const stop = vi.fn(),
      submit = vi.fn();
    const { rerender } = render(
      <PromptInput loading defaultValue="In flight" onSubmit={submit} />,
    );
    expect(
      screen.getByRole("button", { name: "Stop generating" }),
    ).toBeDisabled();
    rerender(
      <PromptInput
        loading
        defaultValue="In flight"
        onStop={stop}
        onSubmit={submit}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop generating" }));
    expect(stop).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue("In flight");
  });

  it("changes model through its selector and uses the new model for submission", async () => {
    const submit = vi.fn(),
      modelChange = vi.fn();
    render(
      <PromptInput
        defaultValue="Prompt"
        models={[
          { value: "small", label: "Small model" },
          { value: "large", label: "Large model" },
          { value: "unavailable", label: "Unavailable model", disabled: true },
        ]}
        onModelChange={modelChange}
        onSubmit={submit}
      />,
    );
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: "Large model" }));
    expect(modelChange).toHaveBeenCalledWith("large");
    fireEvent.click(screen.getByRole("button", { name: "Send prompt" }));
    expect(submit).toHaveBeenCalledWith("Prompt", "large");
  });

  it("performs an add-to-prompt action and closes its action panel", async () => {
    const action = vi.fn();
    render(
      <PromptInput
        actions={[
          {
            value: "file",
            label: "Attach file",
            description: "Choose a local file",
          },
          { value: "disabled", label: "Unavailable", disabled: true },
        ]}
        onAction={action}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add to prompt" }));
    const disabled = await screen.findByRole("button", { name: "Unavailable" });
    expect(disabled).toBeDisabled();
    fireEvent.click(disabled);
    expect(action).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Attach file/ }));
    expect(action).toHaveBeenCalledWith("file");
    expect(
      screen.getByRole("button", { name: "Add to prompt" }),
    ).toHaveAttribute("aria-expanded", "false");
  });
});

describe("message bubble expansion", () => {
  it("expands and restores clamping and associates the toggle with the content", () => {
    render(
      <MessageBubble variant="outline" align="end">
        <MessageBubbleContent>
          <MessageBubbleCollapsible collapsedLines={2}>
            Long message body
          </MessageBubbleCollapsible>
        </MessageBubbleContent>
      </MessageBubble>,
    );
    const expand = screen.getByRole("button", { name: "Show more" });
    const body = document.getElementById(
      expand.getAttribute("aria-controls") as string,
    );
    expect(body).toHaveClass("line-clamp-2");
    fireEvent.click(expand);
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(body).not.toHaveClass("line-clamp-2");
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(body).toHaveClass("line-clamp-2");
  });

  it("keeps controlled collapse state under its owner and forwards both refs through an interactive content element", () => {
    const childRef = createRef<HTMLButtonElement>(),
      contentRef = createRef<HTMLDivElement>();
    const clicked = vi.fn(),
      changed = vi.fn();
    const { rerender } = render(
      <MessageBubble variant="danger" animateIn>
        <MessageBubbleContent
          ref={contentRef}
          render={<button type="button" ref={childRef} onClick={clicked} />}
        >
          Retry message
        </MessageBubbleContent>
      </MessageBubble>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry message" }));
    expect(clicked).toHaveBeenCalledOnce();
    expect(childRef.current).toBe(contentRef.current);
    rerender(
      <MessageBubble variant="ghost">
        <MessageBubbleContent>
          <MessageBubbleCollapsible open={false} onOpenChange={changed}>
            Long body
          </MessageBubbleCollapsible>
        </MessageBubbleContent>
      </MessageBubble>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(changed).toHaveBeenCalledWith(true);
    expect(screen.getByRole("button", { name: "Show more" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });
});
