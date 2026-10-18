import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type * as MotionReact from "motion/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageScroller } from "@/components/agents/message-scroller";

const preference = vi.hoisted(() => ({ reduced: false }));
vi.mock("motion/react", async (original) => ({
  ...(await original<typeof MotionReact>()),
  useReducedMotion: () => preference.reduced,
}));
let frames: Map<number, FrameRequestCallback>;
let counter = 0;
let resize: Array<{ callback: ResizeObserverCallback; targets: Element[] }>;
beforeEach(() => {
  frames = new Map();
  resize = [];
  counter = 0;
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++counter, callback);
    return counter;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      entry: { callback: ResizeObserverCallback; targets: Element[] };
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: [] };
        resize.push(this.entry);
      }
      observe(target: Element) {
        this.entry.targets.push(target);
      }
      unobserve() {}
      disconnect() {
        this.entry.targets = [];
      }
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  preference.reduced = false;
});
function flushFrames() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(16);
  });
}
function grow() {
  act(() => {
    for (const observer of resize) observer.callback([], {} as ResizeObserver);
  });
  flushFrames();
}
const messages = (
  <>
    <article data-slot="message" data-from="user">
      <span>Metadata excluded</span>
      <div data-slot="message-bubble-content">First question</div>
    </article>
    <article data-slot="message" data-from="assistant">
      <div data-slot="message-content">Helpful assistant response</div>
    </article>
    <article data-slot="message">Last message</article>
  </>
);

describe("message scroller live edge", () => {
  it.each([
    { reduced: false, smooth: true, behavior: "smooth" },
    { reduced: true, smooth: true, behavior: "auto" },
    { reduced: false, smooth: false, behavior: "auto" },
  ])(
    "follows growth using $behavior with reduced=$reduced smooth=$smooth",
    ({ reduced, smooth, behavior }) => {
      preference.reduced = reduced;
      render(<MessageScroller smooth={smooth}>{messages}</MessageScroller>);
      const viewport = screen.getByRole("region", { name: "Conversation" });
      const scroll = vi.fn();
      Object.defineProperty(viewport, "scrollTo", { value: scroll });
      flushFrames();
      expect(scroll).toHaveBeenLastCalledWith({ top: 1000, behavior: "auto" });
      grow();
      expect(scroll).toHaveBeenLastCalledWith({ top: 1000, behavior });
    },
  );
  it.each(["wheel", "touch", "ArrowUp", "PageUp", "Home"])(
    "lets %s interrupt automated scrolling and resumes only at the live edge",
    (input) => {
      const following = vi.fn();
      render(
        <MessageScroller onFollowChange={following}>
          {messages}
        </MessageScroller>,
      );
      const viewport = screen.getByRole("region", { name: "Conversation" });
      const scroll = vi.fn();
      Object.defineProperty(viewport, "scrollTo", { value: scroll });
      flushFrames();
      viewport.scrollTop = 100;
      fireEvent.scroll(viewport);
      expect(following).not.toHaveBeenCalled();
      if (input === "wheel") fireEvent.wheel(viewport);
      else if (input === "touch") fireEvent.touchStart(viewport);
      else fireEvent.keyDown(viewport, { key: input });
      fireEvent.scroll(viewport);
      expect(following).toHaveBeenLastCalledWith(false);
      scroll.mockClear();
      grow();
      expect(scroll).not.toHaveBeenCalled();
      viewport.scrollTop = 780;
      fireEvent.scroll(viewport);
      expect(following).toHaveBeenLastCalledWith(true);
      grow();
      expect(scroll).toHaveBeenCalled();
    },
  );
  it("supports fallback scrolling without scrollTo and leaves disabled following untouched", () => {
    const { rerender } = render(
      <MessageScroller followOutput={false}>{messages}</MessageScroller>,
    );
    const viewport = screen.getByRole("region", { name: "Conversation" });
    Object.defineProperty(viewport, "scrollTo", { value: undefined });
    grow();
    expect(viewport.scrollTop).toBe(0);
    rerender(<MessageScroller>{messages}</MessageScroller>);
    flushFrames();
    expect(viewport.scrollTop).toBe(1000);
  });
  it("forwards viewport refs/events and maintains a polite busy transcript", () => {
    const ref = createRef<HTMLElement>(),
      scroll = vi.fn(),
      wheel = vi.fn(),
      touch = vi.fn(),
      key = vi.fn();
    const { rerender } = render(
      <MessageScroller
        viewportRef={ref}
        busy
        label="Transcript"
        viewportProps={{
          onScroll: scroll,
          onWheel: wheel,
          onTouchStart: touch,
          onKeyDown: key,
        }}
      >
        {messages}
      </MessageScroller>,
    );
    const viewport = screen.getByRole("region", { name: "Transcript" });
    expect(ref.current).toBe(viewport);
    expect(screen.getByRole("log")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("log")).toHaveAttribute("aria-live", "polite");
    fireEvent.wheel(viewport);
    fireEvent.touchStart(viewport);
    fireEvent.keyDown(viewport, { key: "ArrowDown" });
    fireEvent.scroll(viewport);
    expect(scroll).toHaveBeenCalledOnce();
    expect(wheel).toHaveBeenCalledOnce();
    expect(touch).toHaveBeenCalledOnce();
    expect(key).toHaveBeenCalledOnce();
    const callback = vi.fn();
    rerender(
      <MessageScroller viewportRef={callback}>{messages}</MessageScroller>,
    );
    expect(callback).toHaveBeenCalledWith(viewport);
    expect(ref.current).toBeNull();
  });
});

describe("message navigation rail", () => {
  it("uses message content rather than metadata in previews and pairs a question with its assistant answer", () => {
    render(
      <MessageScroller navigation="rail" followOutput={false}>
        {messages}
      </MessageScroller>,
    );
    flushFrames();
    const first = screen.getByRole("button", {
      name: "Go to user message 1 of 3",
    });
    fireEvent.pointerEnter(first, { pointerType: "mouse" });
    expect(
      screen.getByText("First question", {
        selector: '[data-slot="preview-rail-title"]',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Helpful assistant response", {
        selector: '[data-slot="preview-rail-description"]',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Metadata excluded")).toBeInTheDocument();
  });
  it.each([true, false])(
    "centers earlier messages then resumes the live edge on the final message, scrollTo=%s",
    (hasScrollTo) => {
      const following = vi.fn();
      render(
        <MessageScroller
          navigation="rail"
          followOutput={false}
          smooth={false}
          onFollowChange={following}
        >
          {messages}
        </MessageScroller>,
      );
      const viewport = screen.getByRole("region", { name: "Conversation" });
      const scroll = vi.fn();
      Object.defineProperty(viewport, "scrollTo", {
        value: hasScrollTo ? scroll : undefined,
      });
      viewport.scrollTop = 300;
      vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
        top: 10,
        height: 200,
      } as DOMRect);
      const firstMessage = viewport.querySelector(
        '[data-slot="message"]',
      ) as HTMLElement;
      vi.spyOn(firstMessage, "getBoundingClientRect").mockReturnValue({
        top: 50,
        height: 40,
      } as DOMRect);
      flushFrames();
      fireEvent.click(
        screen.getByRole("button", { name: "Go to user message 1 of 3" }),
      );
      if (hasScrollTo)
        expect(scroll).toHaveBeenLastCalledWith({ top: 260, behavior: "auto" });
      else expect(viewport.scrollTop).toBe(260);
      fireEvent.click(
        screen.getByRole("button", {
          name: "Go to conversation message 3 of 3",
        }),
      );
      expect(following).toHaveBeenLastCalledWith(true);
      if (hasScrollTo)
        expect(scroll).toHaveBeenLastCalledWith({
          top: 1000,
          behavior: "auto",
        });
      else expect(viewport.scrollTop).toBe(1000);
    },
  );
  it.each(["word-boundary", "unbroken", "blank"])(
    "provides readable navigation previews for %s messages",
    (mode) => {
      const text =
        mode === "word-boundary"
          ? "This is a long question with words that should break near the boundary and continue with useful context for the reader."
          : mode === "unbroken"
            ? "A".repeat(180)
            : "   ";
      render(
        <MessageScroller navigation="rail" followOutput={false}>
          <article data-slot="message">{text}</article>
          <article data-slot="message">Next message</article>
        </MessageScroller>,
      );
      flushFrames();
      fireEvent.pointerEnter(
        screen.getByRole("button", {
          name: "Go to conversation message 1 of 2",
        }),
        { pointerType: "mouse" },
      );
      const title = document.querySelector('[data-slot="preview-rail-title"]');
      if (mode === "blank") expect(title).toHaveTextContent("Message");
      else {
        expect(title?.textContent?.endsWith("…")).toBe(true);
        expect(
          document.querySelector('[data-slot="preview-rail-description"]'),
        ).toBeInTheDocument();
      }
    },
  );
  it("removes stale navigation when messages cease overflowing or navigation is disabled", () => {
    const { rerender } = render(
      <MessageScroller navigation="rail" followOutput={false}>
        {messages}
      </MessageScroller>,
    );
    flushFrames();
    expect(screen.getAllByRole("button", { name: /Go to/ })).toHaveLength(3);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(200);
    grow();
    expect(
      screen.queryByRole("button", { name: /Go to/ }),
    ).not.toBeInTheDocument();
    rerender(
      <MessageScroller followOutput={false}>{messages}</MessageScroller>,
    );
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });
});

describe("navigation tracks the visible transcript", () => {
  it("highlights the first, nearest middle and final message as the reader scrolls", () => {
    render(
      <MessageScroller navigation="rail" followOutput={false}>
        {messages}
      </MessageScroller>,
    );
    const viewport = screen.getByRole("region", { name: "Conversation" });
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
      top: 0,
      height: 200,
    } as DOMRect);
    for (const [index, message] of Array.from(
      viewport.querySelectorAll<HTMLElement>('[data-slot="message"]'),
    ).entries()) {
      vi.spyOn(message, "getBoundingClientRect").mockImplementation(
        () =>
          ({
            top: 100 + index * 400 - viewport.scrollTop,
            height: 40,
          }) as DOMRect,
      );
    }
    flushFrames();
    const buttons = screen.getAllByRole("button", { name: /Go to/ });
    expect(buttons[0]).toHaveAttribute("aria-current", "location");
    viewport.scrollTop = 400;
    fireEvent.scroll(viewport);
    expect(buttons[1]).toHaveAttribute("aria-current", "location");
    expect(buttons[0]).not.toHaveAttribute("aria-current");
    fireEvent.scroll(viewport);
    expect(buttons[1]).toHaveAttribute("aria-current", "location");
    viewport.scrollTop = 790;
    fireEvent.scroll(viewport);
    expect(buttons[2]).toHaveAttribute("aria-current", "location");
    viewport.scrollTop = 0;
    fireEvent.scroll(viewport);
    expect(buttons[0]).toHaveAttribute("aria-current", "location");
  });
  it.each(["word boundary ".repeat(20), "Z".repeat(200)])(
    "truncates an oversized assistant preview without losing the complete message",
    (response) => {
      render(
        <MessageScroller navigation="rail" followOutput={false}>
          <article data-slot="message" data-from="user">
            Question
          </article>
          <article data-slot="message" data-from="assistant">
            {response}
          </article>
        </MessageScroller>,
      );
      flushFrames();
      fireEvent.pointerEnter(
        screen.getByRole("button", { name: "Go to user message 1 of 2" }),
        { pointerType: "mouse" },
      );
      const preview = document.querySelector(
        '[data-slot="preview-rail-description"]',
      );
      expect(preview?.textContent?.endsWith("…")).toBe(true);
      expect(preview?.textContent?.length).toBeLessThanOrEqual(89);
      expect(
        screen.getByText(response.trim(), { selector: "article" }),
      ).toBeInTheDocument();
    },
  );
});
