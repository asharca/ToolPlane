import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Citation, Citations } from "@/components/agents/citations";
import { CodeBlock } from "@/components/agents/code-block";
import { ReasoningText } from "@/components/agents/loading-states/reasoning-text";

const originalDecode = Object.getOwnPropertyDescriptor(
  HTMLImageElement.prototype,
  "decode",
);
beforeEach(() => {
  Object.defineProperty(HTMLImageElement.prototype, "decode", {
    configurable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
});
afterEach(() => {
  if (originalDecode)
    Object.defineProperty(HTMLImageElement.prototype, "decode", originalDecode);
  else Reflect.deleteProperty(HTMLImageElement.prototype, "decode");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("agent code block", () => {
  it("copies the exact multi-line source and resets its confirmation after the feedback interval", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const code = "const count = 2;\nconsole.log(count);";
    render(<CodeBlock code={code} filename="counter.ts" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    });
    expect(writeText).toHaveBeenCalledWith(code);
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1599));
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(
      screen.getByRole("button", { name: "Copy code" }),
    ).toBeInTheDocument();
  });

  it("waits for a custom copy action, even when default copying is disabled", async () => {
    let resolve = () => {};
    const onCopy = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const { rerender } = render(
      <CodeBlock
        code="echo ready"
        language="bash"
        copyable={false}
        onCopy={onCopy}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    expect(onCopy).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("button", { name: "Copied" }),
    ).not.toBeInTheDocument();
    await act(async () => resolve());
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    rerender(<CodeBlock code="echo ready" language="bash" copyable={false} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("exposes streamed code as a live log and removes the live region once complete", async () => {
    const { rerender, container } = render(
      <CodeBlock
        code="const initial = 1;"
        status="streaming"
        showLineNumbers={false}
        wrap
      />,
    );
    expect(screen.getByRole("log")).toHaveAttribute("aria-live", "polite");
    expect(container.firstElementChild).toHaveAttribute("aria-busy", "true");
    rerender(
      <CodeBlock
        code="const initial = 1;\nconst final = 2;"
        status="complete"
        highlightLines={[2]}
      />,
    );
    expect(screen.queryByRole("log")).not.toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute("aria-busy", "false");
    await waitFor(() =>
      expect(container.querySelector("code")).toHaveTextContent(
        "const final = 2;",
      ),
    );
    expect(container.querySelector("code")).toHaveTextContent(
      "const initial = 1;",
    );
  });
});

describe("citation disclosure", () => {
  const citations = [
    {
      id: "docs/intro",
      title: "Documentation",
      domain: "example.com",
      url: "https://example.com/docs",
    },
    { id: "local", title: "Local notes" },
  ];

  it("reveals sources with safe external links and matching inline citation anchors", () => {
    render(
      <>
        <Citation citationId="docs/intro" idPrefix="answer" index={1} />
        <Citations citations={citations} idPrefix="answer" />
      </>,
    );
    const trigger = screen.getByRole("button", { name: /^Sources\s*2$/ });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("link", { name: /Documentation/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const source = screen.getByRole("link", { name: /Documentation/ });
    expect(source).toHaveAttribute("href", "https://example.com/docs");
    expect(source).toHaveAttribute("rel", "noreferrer noopener");
    expect(source).toHaveAttribute("target", "_blank");
    expect(
      screen.getByRole("link", { name: "View citation 1" }),
    ).toHaveAttribute("href", `#${source.id}`);
    expect(screen.getByText("Local notes").closest("a")).toBeNull();
    fireEvent.click(trigger);
    expect(
      screen.queryByRole("link", { name: /Documentation/ }),
    ).not.toBeInTheDocument();
  });

  it("reports controlled disclosure requests without overriding the parent state", () => {
    const changed = vi.fn();
    const { rerender } = render(
      <Citations citations={citations} open={false} onOpenChange={changed} />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(changed).toHaveBeenCalledWith(true);
    expect(screen.getByRole("button")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    rerender(<Citations citations={citations} open onOpenChange={changed} />);
    fireEvent.click(screen.getByRole("button"));
    expect(changed).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");
  });
});

describe("reasoning status", () => {
  it("cycles announced phrases, enforces a readable minimum interval, and handles a changing phrase list", () => {
    vi.useFakeTimers();
    const { rerender, unmount } = render(
      <ReasoningText
        phrases={["Reading", "Working"]}
        interval={10}
        variant="swap"
        indicator={<span />}
      />,
    );
    expect(screen.getByRole("status", { name: "Reading" })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(599));
    expect(screen.getByRole("status", { name: "Reading" })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("status", { name: "Working" })).toBeInTheDocument();
    rerender(
      <ReasoningText
        phrases={["Only phrase"]}
        variant="cascade"
        indicator={<span />}
      />,
    );
    act(() => vi.advanceTimersByTime(2000));
    expect(
      screen.getByRole("status", { name: "Only phrase" }),
    ).toBeInTheDocument();
    unmount();
  });

  it("falls back to the built-in phrase sequence when given no phrases", () => {
    vi.useFakeTimers();
    render(
      <ReasoningText phrases={[]} variant="scramble" indicator={<span />} />,
    );
    expect(
      screen.getByRole("status", { name: "Thinking" }),
    ).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1800));
    expect(
      screen.getByRole("status", { name: "Reading the context" }),
    ).toBeInTheDocument();
  });
});
