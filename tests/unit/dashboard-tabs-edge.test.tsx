import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DashboardTabBar,
  DashboardTabsProvider,
  reorderDashboardTabs,
  useDashboardTabs,
  type DashboardWorkspaceTab,
} from "@/components/dashboard/DashboardTabs";

const navigation = vi.hoisted(() => ({
  pathname: "",
  search: "",
  push: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.search),
  useRouter: () => ({ push: navigation.push, replace: navigation.replace }),
}));
let slug: string;
let sequence = 0;
interface TabActions {
  activeTabId: string;
  closeTab: (id: string) => void;
  newTab: () => void;
  openInNewWindow: (id: string) => void;
  openRoute: (href: string) => void;
  reorderTabs: (source: string, target: string) => void;
  selectTab: (id: string) => void;
  togglePinned: (id: string) => void;
}
let operation: (tabs: TabActions) => void = () => {};
function Consumer() {
  const state = useDashboardTabs();
  return (
    <>
      <output aria-label="State">
        {JSON.stringify({ tabs: state.tabs, activeTabId: state.activeTabId })}
      </output>
      <button type="button" onClick={() => operation(state)}>
        Operate
      </button>
    </>
  );
}
function readState(): { tabs: DashboardWorkspaceTab[]; activeTabId: string } {
  return JSON.parse(screen.getByLabelText("State").textContent || "null");
}
function mount(bar = false) {
  return render(
    <DashboardTabsProvider slug={slug}>
      <Consumer />
      {bar && <DashboardTabBar />}
    </DashboardTabsProvider>,
  );
}
function run(next: typeof operation) {
  operation = next;
  fireEvent.click(screen.getByRole("button", { name: "Operate" }));
}
function seed(value: unknown) {
  window.sessionStorage.setItem(
    `toolplane:dashboard-tabs:${slug}`,
    JSON.stringify(value),
  );
}
function tab(id: string, path: string, pinned = false) {
  return { id, href: `/app/${slug}/${path}`, pinned };
}

beforeEach(() => {
  slug = `tab-edge-${++sequence}`;
  navigation.pathname = `/app/${slug}/chat`;
  navigation.search = "";
  navigation.push.mockClear();
  navigation.replace.mockClear();
  window.sessionStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe("dashboard tab persistence validation", () => {
  it.each([
    null,
    3,
    "text",
    {},
    { tabs: false },
    { tabs: [] },
    { tabs: [null, 1, {}, { id: 7, href: "/app/team/chat", pinned: false }] },
  ])("recovers a fresh usable route from invalid stored state %#", (value) => {
    seed(value);
    mount();
    expect(readState()).toEqual({
      tabs: [tab("initial", "chat")],
      activeTabId: "initial",
    });
    run((state) => state.openRoute(`/app/${slug}/skills`));
    expect(readState().tabs).toEqual([tab("initial", "skills")]);
  });

  it("filters invalid records, normalizes retained routes, and restores pinned ordering", () => {
    seed({
      tabs: [
        tab(
          "normal",
          "skills?x=1&__dashboardTab=old&__dashboardDetached=1#files",
        ),
        { id: "bad-href", href: 4, pinned: false },
        { id: "bad-pin", href: `/app/${slug}/work`, pinned: "false" },
        tab("overview", "overview"),
        { id: "foreign", href: "/app/foreign/chat", pinned: false },
        tab("saved", "chat", true),
      ],
      activeTabId: "missing",
    });
    mount();
    expect(readState()).toEqual({
      tabs: [tab("saved", "chat", true), tab("normal", "skills?x=1#files")],
      activeTabId: "saved",
    });
  });

  it("honors a requested tab when multiple retained tabs have the same route", () => {
    seed({
      tabs: [tab("first", "chat"), tab("second", "chat")],
      activeTabId: "first",
    });
    navigation.search = "__dashboardTab=second&__dashboardDetached=0";
    mount();
    expect(readState().activeTabId).toBe("second");
    run((state) => state.selectTab("second"));
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it.each([undefined, 4, "nonexistent"])(
    "selects a retained matching route despite invalid saved active id %s",
    (activeTabId) => {
      seed({
        tabs: [tab("saved", "chat", true), tab("other", "skills")],
        activeTabId,
      });
      mount();
      expect(readState().activeTabId).toBe("saved");
    },
  );

  it("adds navigation without overwriting the saved pinned tab", () => {
    seed({ tabs: [tab("saved", "skills", true)], activeTabId: "saved" });
    mount();
    expect(readState().tabs[0]).toEqual(tab("saved", "skills", true));
    expect(readState().tabs[1].href).toBe(`/app/${slug}/chat`);
    expect(readState().activeTabId).toBe(readState().tabs[1].id);
  });

  it("continues to mutate session state when browser storage rejects reads and writes", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    mount();
    run((state) => state.openRoute(`/app/${slug}/work`));
    expect(readState().tabs).toEqual([tab("initial", "work")]);
    run((state) => state.newTab());
    expect(readState().tabs).toHaveLength(2);
  });

  it("ignores parent storage in a detached window", () => {
    seed({ tabs: [tab("parent", "skills")], activeTabId: "parent" });
    navigation.search = "__dashboardDetached=1&__dashboardTab=detached";
    mount();
    expect(readState()).toEqual({
      tabs: [tab("detached", "chat")],
      activeTabId: "detached",
    });
  });

  it("recovers from malformed JSON", () => {
    window.sessionStorage.setItem(`toolplane:dashboard-tabs:${slug}`, "{");
    mount();
    expect(readState().tabs).toEqual([tab("initial", "chat")]);
  });
});

describe("dashboard route and tab transitions", () => {
  it.each([
    ["settings", "/app/foreign/work", "chat"],
    ["settings/profile", "settings/security", "chat"],
    ["agents/a", "work?job=9&__dashboardTab=return", "work?job=9"],
    ["agents/a/deep", "work", "agents/a/deep?returnTo=PLACEHOLDER"],
    ["settings", "work", "work"],
    ["chat", "work", "chat?returnTo=PLACEHOLDER"],
  ])(
    "keeps modal return routes scoped for %s / %s",
    (path, returnPath, expected) => {
      const returnTo = returnPath.startsWith("/")
        ? returnPath
        : `/app/${slug}/${returnPath}`;
      navigation.pathname = `/app/${slug}/${path}`;
      navigation.search = new URLSearchParams({ returnTo }).toString();
      mount();
      const expectedHref = expected.includes("PLACEHOLDER")
        ? `/app/${slug}/${path}?${navigation.search}`
        : `/app/${slug}/${expected}`;
      expect(readState().tabs[0].href).toBe(expectedHref);
    },
  );

  it("defaults a missing pathname and settings without a return route to chat", () => {
    navigation.pathname = "";
    mount();
    expect(readState().tabs[0].href).toBe(`/app/${slug}/chat`);
  });

  it("uses existing tabs, ignores missing selections, and closes inactive tabs without navigation", () => {
    seed({
      tabs: [tab("chat", "chat"), tab("skills", "skills"), tab("work", "work")],
      activeTabId: "chat",
    });
    mount();
    run((state) => state.selectTab("absent"));
    expect(navigation.push).not.toHaveBeenCalled();
    run((state) => state.closeTab("work"));
    expect(readState().tabs.map((item) => item.id)).toEqual(["chat", "skills"]);
    expect(navigation.replace).not.toHaveBeenCalled();
    run((state) =>
      state.openRoute(
        `/app/${slug}/skills?__dashboardTab=ignored&__dashboardDetached=1`,
      ),
    );
    expect(readState().activeTabId).toBe("skills");
    expect(navigation.push).toHaveBeenLastCalledWith(
      `/app/${slug}/skills?__dashboardTab=skills`,
    );
    run((state) => state.closeTab("skills"));
    expect(readState().activeTabId).toBe("chat");
    run((state) => state.closeTab("chat"));
    expect(readState().tabs).toHaveLength(1);
  });

  it("closes an active first tab using its right neighbor and preserves routing intent", () => {
    seed({
      tabs: [tab("chat", "chat"), tab("skills", "skills")],
      activeTabId: "chat",
    });
    const view = mount();
    run((state) => state.closeTab("chat"));
    expect(readState().activeTabId).toBe("skills");
    expect(navigation.replace).toHaveBeenLastCalledWith(
      `/app/${slug}/skills?__dashboardTab=skills`,
    );
    navigation.pathname = `/app/${slug}/skills`;
    navigation.search = "__dashboardTab=skills";
    view.rerender(
      <DashboardTabsProvider slug={slug}>
        <Consumer />
      </DashboardTabsProvider>,
    );
    expect(readState().tabs).toEqual([tab("skills", "skills")]);
  });

  it("persists reordering and pin/unpin transitions", () => {
    seed({
      tabs: [tab("a", "chat"), tab("b", "skills"), tab("c", "work")],
      activeTabId: "a",
    });
    mount();
    run((state) => state.reorderTabs("c", "a"));
    expect(readState().tabs.map((item) => item.id)).toEqual(["c", "a", "b"]);
    run((state) => state.togglePinned("b"));
    expect(readState().tabs[0]).toEqual(tab("b", "skills", true));
    run((state) => state.togglePinned("b"));
    expect(readState().tabs[0]).toEqual(tab("b", "skills"));
  });

  it("detaches one tab from a multi-tab session and ignores nonexistent ids", () => {
    seed({
      tabs: [tab("chat", "chat"), tab("skills", "skills")],
      activeTabId: "chat",
    });
    const replace = vi.fn();
    const popup = {
      opener: window,
      location: { replace },
    } as unknown as Window;
    const open = vi.spyOn(window, "open").mockReturnValue(popup);
    mount();
    run((state) => state.openInNewWindow("absent"));
    expect(open).not.toHaveBeenCalled();
    run((state) => state.openInNewWindow("skills"));
    expect(popup.opener).toBeNull();
    expect(replace).toHaveBeenCalledWith(
      `/app/${slug}/skills?__dashboardTab=skills&__dashboardDetached=1`,
    );
    expect(readState().tabs).toEqual([tab("chat", "chat")]);
  });

  it("generates usable ids without randomUUID", () => {
    vi.stubGlobal("crypto", {});
    try {
      mount();
      run((state) => state.newTab());
      expect(readState().tabs[1].id).toMatch(/^\d+-[a-z0-9]+$/);
      expect(navigation.push).toHaveBeenCalledWith(
        expect.stringContaining(`__dashboardTab=${readState().tabs[1].id}`),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("labels retained nested and unknown routes and selects them from the real tab bar", async () => {
    seed({
      tabs: [
        tab("chat", "chat"),
        tab("skills", "skills/nested"),
        tab("unknown", "custom"),
      ],
      activeTabId: "chat",
    });
    await act(async () => {
      mount(true);
    });
    const skill = screen.getByRole("tab", { name: "Skills" });
    fireEvent.click(skill);
    expect(readState().activeTabId).toBe("skills");
    expect(screen.getAllByRole("tab", { name: "Assistants" })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "新建标签" }));
    expect(readState().tabs).toHaveLength(4);
  });
});

describe("dashboard tab ordering guards", () => {
  it("preserves identity for invalid moves and orders pinned peers", () => {
    const tabs = [
      tab("p1", "chat", true),
      tab("p2", "skills", true),
      tab("a", "work"),
    ];
    for (const [source, target] of [
      ["missing", "p1"],
      ["p1", "missing"],
      ["p1", "p1"],
      ["p1", "a"],
    ])
      expect(reorderDashboardTabs(tabs, source, target)).toBe(tabs);
    expect(
      reorderDashboardTabs(tabs, "p2", "p1").map((item) => item.id),
    ).toEqual(["p2", "p1", "a"]);
  });
});
