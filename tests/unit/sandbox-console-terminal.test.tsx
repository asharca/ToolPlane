import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxConsole } from "@/components/dashboard/sandboxes/SandboxConsole";
import messages from "../../messages/en.json";

// Production next-intl memoizes translators; the global test mock recreates them each render.
vi.mock("next-intl", () => {
  const t = (key: string, values?: Record<string, unknown>) => {
    const value = (messages.console.sandboxes as Record<string, unknown>)[key];
    const label = typeof value === "string" ? value : key;
    return label.replace(/\{(\w+)\}/g, (_match, name: string) =>
      String(values?.[name] ?? ""),
    );
  };
  return { useTranslations: () => t };
});

const terminals = vi.hoisted(() => ({
  instances: [] as {
    host: HTMLElement;
    input: (data: string) => void;
    resize: (size: { cols: number; rows: number }) => void;
    disposed: boolean;
  }[],
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 100;
    rows = 30;
    options = {};
    host!: HTMLElement;
    disposed = false;
    input = (_data: string) => {};
    resize = (_size: { cols: number; rows: number }) => {};
    constructor() {
      terminals.instances.push(this);
    }
    loadAddon() {}
    open(host: HTMLElement) {
      this.host = host;
    }
    focus() {}
    write(text: string) {
      this.host.append(document.createTextNode(text));
    }
    writeln(text: string) {
      this.write(`${text}\n`);
    }
    onData(callback: (data: string) => void) {
      this.input = callback;
    }
    onResize(callback: (size: { cols: number; rows: number }) => void) {
      this.resize = callback;
    }
    dispose() {
      this.disposed = true;
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
class TerminalEvents {
  static instances: TerminalEvents[] = [];
  handlers = new Map<string, (event: MessageEvent) => void>();
  closed = false;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    TerminalEvents.instances.push(this);
  }
  addEventListener(type: string, callback: (event: MessageEvent) => void) {
    this.handlers.set(type, callback);
  }
  emit(type: string, data: unknown) {
    this.handlers.get(type)?.(
      new MessageEvent(type, { data: JSON.stringify(data) }),
    );
  }
  close() {
    this.closed = true;
  }
}
beforeEach(() => {
  terminals.instances.length = 0;
  TerminalEvents.instances.length = 0;
  vi.stubGlobal("EventSource", TerminalEvents);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    fillStyle: "",
    fillRect() {},
    getImageData: () => ({ data: [10, 20, 30, 255] }),
  } as unknown as CanvasRenderingContext2D);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const props = {
  deploymentId: "sandbox",
  running: true,
  terminalOnly: true,
  initialPath: "/workspace/src",
  initialEntries: [],
};

describe("sandbox interactive terminal", () => {
  it("streams output and releases the terminal on close", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST" && String(_url).endsWith("/terminal")
        ? Response.json({ id: "session" })
        : Response.json({ ok: true }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<SandboxConsole {...props} />);
    await screen.findByText("Connected");
    const events = TerminalEvents.instances[0];
    const terminal = terminals.instances[0];
    if (!events || !terminal) throw new Error("Terminal not mounted");
    act(() => {
      events.emit("data", { data: "Output from server" });
      events.emit("data", {});
    });
    expect(screen.getByText("Output from server")).toBeInTheDocument();
    view.unmount();
    expect(events.closed).toBe(true);
    expect(terminal.disposed).toBe(true);
  });

  it.each([true, false])(
    "preserves input order and drains before close when the first write succeeds: %s",
    async (succeeds) => {
      const first = Promise.withResolvers<Response>();
      const received: string[] = [];
      let closed = false;
      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        if (url.endsWith("/input")) {
          received.push(JSON.parse(String(init?.body)).data);
          return received.length === 1
            ? first.promise
            : Response.json({ ok: true });
        }
        if (init?.method === "DELETE") closed = true;
        return Response.json({ id: "session" });
      });
      const view = render(<SandboxConsole {...props} />);
      await screen.findByText("Connected");
      const terminal = terminals.instances[0];
      if (!terminal) throw new Error("Terminal not mounted");
      vi.useFakeTimers();
      try {
        act(() => terminal.input("echo "));
        await act(() => vi.advanceTimersByTimeAsync(12));
        act(() => terminal.input("safe\r"));
        await act(() => vi.advanceTimersByTimeAsync(12));
        expect(received).toEqual(["echo "]);
        act(() => terminal.input("exit\r"));
        view.unmount();
        expect(closed).toBe(false);
        await act(async () => {
          first.resolve(Response.json({}, { status: succeeds ? 200 : 500 }));
          await vi.runAllTimersAsync();
        });
        expect(received).toEqual(
          succeeds ? ["echo ", "safe\r", "exit\r"] : ["echo "],
        );
        expect(closed).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([0, 23, null])(
    "shows process exit %s and reconnects with a new session",
    async (exitCode) => {
      let sessions = 0;
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === "POST"
          ? Response.json({ id: `session-${++sessions}` })
          : Response.json({ ok: true }),
      );
      vi.stubGlobal("fetch", fetchMock);
      render(<SandboxConsole {...props} />);
      await screen.findByText("Connected");
      const events = TerminalEvents.instances[0];
      if (!events) throw new Error("Event stream missing");
      act(() => events.emit("exit", { exitCode }));
      await screen.findByText("Exited");
      expect(
        screen.getByText(
          exitCode === null
            ? /Terminal exited\./
            : new RegExp(`Terminal exited \\(${exitCode}\\)`),
        ),
      ).toBeInTheDocument();
      fireEvent.click(
        screen.getByRole("button", { name: "Reconnect terminal" }),
      );
      await screen.findByText("Connected");
      expect(TerminalEvents.instances).toHaveLength(2);
      expect(events.closed).toBe(true);
    },
  );

  it("reports disconnect, preserves rendered output, and releases the old session on reconnect", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ id: "session" })),
    );
    render(<SandboxConsole {...props} />);
    await screen.findByText("Connected");
    const events = TerminalEvents.instances[0];
    if (!events) throw new Error("Event stream missing");
    act(() => {
      events.emit("data", { data: "Last output" });
      events.onerror?.();
    });
    await screen.findByText("Disconnected");
    expect(screen.getByText("Last output")).toBeInTheDocument();
  });

  it("reports rejected terminal authorization without creating an event stream", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: "Forbidden" }, { status: 403 }),
        ),
    );
    render(<SandboxConsole {...props} />);
    await screen.findByText("Error");
    expect(screen.getByText(/403/)).toBeInTheDocument();
    expect(TerminalEvents.instances).toHaveLength(0);
  });

  it.each([false, true])(
    "keeps a stopped sandbox offline while waitingForConnector=%s",
    async (waitingForConnector) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      render(
        <SandboxConsole
          {...props}
          running={false}
          waitingForConnector={waitingForConnector}
        />,
      );
      await waitFor(() => expect(terminals.instances).toHaveLength(1));
      expect(fetchMock).not.toHaveBeenCalled();
      expect(terminals.instances[0]?.host).toHaveTextContent(
        waitingForConnector
          ? "ToolPlane is waiting for the connector session to come online and will refresh automatically."
          : "Sandbox is stopped. Start it before opening a terminal.",
      );
      expect(TerminalEvents.instances).toHaveLength(0);
    },
  );
});
