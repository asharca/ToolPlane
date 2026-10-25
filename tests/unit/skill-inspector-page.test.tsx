import {
  Children,
  cloneElement,
  isValidElement,
  type ComponentProps,
  type ReactNode,
} from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  workspace: vi.fn(),
  install: vi.fn(),
  agents: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("next-intl/server", () => ({
  getLocale: async () => "en",
  getTranslations: async () => (key: string) => key,
}));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/workspace/queries", () => ({
  getWorkspaceForUser: mocks.workspace,
}));
vi.mock("@/lib/db", () => ({
  db: {
    installedSkill: { findFirst: mocks.install },
    agent: { findMany: mocks.agents },
  },
}));
vi.mock("@/lib/skills/actions", () => ({
  deleteCustomSkillAction: vi.fn(),
  updateSkillAttributesAction: vi.fn(),
}));
vi.mock("@/lib/agents/actions", () => ({
  enableAgentResourceAction: vi.fn(),
  previewAgentResourceAction: vi.fn(),
}));
vi.mock("@/components/motion/bouncy-accordion", () => ({
  BouncyAccordion: ({
    items,
  }: {
    items: { id: string; title: string; description: ReactNode }[];
  }) => (
    <>
      {items.map((item) => (
        <section key={item.id} aria-label={item.title}>
          {item.description}
        </section>
      ))}
    </>
  ),
}));
vi.mock("@/components/dashboard/SkillMarkdownViewer", () => ({
  SkillMarkdownViewer: ({
    markdown,
    downloadHref,
    editable,
  }: {
    markdown: string;
    downloadHref: string;
    editable?: unknown;
  }) => (
    <section>
      <pre>{markdown}</pre>
      <a href={downloadHref}>Download SKILL.md</a>
      {editable ? <button type="button">Edit instructions</button> : null}
    </section>
  ),
}));
vi.mock("@/components/dashboard/FilePathTree", () => ({
  BundledFiles: ({ files }: { files: { path: string; size: string }[] }) => (
    <ul>
      {files.map((file) => (
        <li key={file.path}>
          {file.path} {file.size}
        </li>
      ))}
    </ul>
  ),
}));
vi.mock("@/components/dashboard/ConfirmSubmitButton", () => ({
  ConfirmSubmitButton: ({ triggerLabel }: { triggerLabel: string }) => (
    <button type="button">{triggerLabel}</button>
  ),
}));

import SkillInspectorPage from "@/app/app/[workspace]/skills/[installId]/page";
import { ResourceEnablePanel } from "@/components/dashboard/market/ResourceEnablePanel";

const page = async () => {
  const element = await SkillInspectorPage({
    params: Promise.resolve({ workspace: "acme", installId: "install-1" }),
  });
  // Resolve the nested server component before crossing into the DOM renderer.
  const children = await Promise.all(
    Children.toArray(element.props.children).map((child) =>
      isValidElement<ComponentProps<typeof ResourceEnablePanel>>(child) &&
      child.type === ResourceEnablePanel
        ? ResourceEnablePanel(child.props)
        : child,
    ),
  );
  return cloneElement(element, {}, children);
};
const base = () => ({
  id: "install-1",
  name: "Writer",
  slug: "writer",
  skillId: null,
  skill: null,
  marketInstall: null,
  toolkitLinks: [],
  source: "custom",
  sourceRef: null,
  description: "Database description",
  content:
    "---\nname: writer\ndescription: 'Artifact description'\n---\n# Instructions",
  files: [],
  effort: "default",
  userInvocable: true,
  agentInvocable: false,
  createdAt: new Date("2026-08-01T12:00:00Z"),
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.user.mockResolvedValue({ id: "user-1", timeZone: "UTC" });
  mocks.workspace.mockResolvedValue({ id: "ws-1" });
  mocks.install.mockResolvedValue(base());
  mocks.agents.mockResolvedValue([
    { id: "agent-1", name: "Writing agent", currentRevisionVersion: 1 },
  ]);
});
afterEach(cleanup);

describe("installed skill inspector", () => {
  it("does not expose private installations to anonymous users", async () => {
    mocks.user.mockResolvedValue(null);
    await expect(page()).rejects.toThrow("redirect:/app/login");
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it("rejects inaccessible workspaces before querying installations", async () => {
    mocks.workspace.mockResolvedValue(null);
    await expect(page()).rejects.toThrow("redirect:/app");
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it("returns notFound for missing or cross-workspace installation IDs", async () => {
    mocks.install.mockResolvedValue(null);
    await expect(page()).rejects.toThrow("notFound");
    expect(mocks.install).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "install-1", workspaceId: "ws-1" },
      }),
    );
  });
  it("uses artifact metadata and exposes custom-only edit controls", async () => {
    render(await page());
    expect(screen.getByRole("heading", { name: "Writer" })).toBeInTheDocument();
    expect(screen.getByText("Artifact description")).toBeInTheDocument();
    expect(screen.queryByText("Database description")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edit instructions" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "delete" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "save" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "user" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "agent" })).not.toBeChecked();
    expect(
      screen.getByRole("link", { name: "Download SKILL.md" }),
    ).toHaveAttribute("href", "/api/v1/skills/install-1/download");
    expect(
      screen.getByText("noBundledFilesThisSkillSyncsAsASingleSkillmdFile"),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Writing agent" })).toHaveValue(
      "agent-1",
    );
    expect(mocks.agents).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId: "ws-1",
          runtimeKind: "pi-sdk",
          retiredAt: null,
          publicRuntimeAllocation: null,
        },
      }),
    );
    expect(
      screen.getByRole("button", { name: "resourceApplyRevision" }),
    ).toBeDisabled();
  });
  it("uses catalog identity and hides custom mutation controls", async () => {
    mocks.install.mockResolvedValue({
      ...base(),
      skillId: "catalog-1",
      skill: {
        name: "Catalog Writer",
        slug: "catalog-writer",
        description: "Catalog description",
        content: "# Catalog instructions",
        githubSource:
          "https://raw.githubusercontent.com/acme/skills/main/docs/SKILL.md",
        files: [],
      },
      marketInstall: { id: "market-1" },
      effort: "low",
    });
    render(await page());
    expect(
      screen.getByRole("heading", { name: "Catalog Writer" }),
    ).toBeInTheDocument();
    expect(screen.getByText("# Catalog instructions")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "openGithub" })).toHaveAttribute(
      "href",
      "https://github.com/acme/skills/blob/main/docs/SKILL.md",
    );
    expect(
      screen.getByRole("link", { name: "manageMarketInstall" }),
    ).toHaveAttribute("href", "/app/acme/market/installed");
    expect(
      screen.queryByRole("button", { name: "Edit instructions" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "save" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("low")).toBeInTheDocument();
  });
  it("routes custom market and toolkit-managed removal through market management", async () => {
    mocks.install.mockResolvedValue({
      ...base(),
      toolkitLinks: [{ toolkitId: "toolkit-1" }],
      effort: "high",
    });
    render(await page());
    expect(
      screen.getByRole("link", { name: "manageMarketInstall" }),
    ).toHaveAttribute("href", "/app/acme/market/installed");
    expect(
      screen.queryByRole("button", { name: "delete" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edit instructions" }),
    ).toBeInTheDocument();
  });
  it("shows uploaded folder provenance as text, not an untrusted external link", async () => {
    mocks.install.mockResolvedValue({
      ...base(),
      source: "upload",
      sourceRef: "my-bundle/skills/writer",
      files: [{ path: "scripts/run.sh", content: "echo hello" }],
    });
    render(await page());
    expect(screen.getByText("importFolder")).toBeInTheDocument();
    expect(screen.getByText("my-bundle/skills/writer")).toBeInTheDocument();
    expect(screen.getByText("scripts/run.sh 10 B")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "my-bundle/skills/writer" }),
    ).not.toBeInTheDocument();
  });
  it.each([
    "javascript:alert(1)",
    "file:///tmp/skill",
    "not a url",
    "https://raw.githubusercontent.com/acme/repo/main",
  ])(
    "never turns unsafe or incomplete provenance %s into a GitHub link",
    async (sourceRef) => {
      mocks.install.mockResolvedValue({
        ...base(),
        source: "github",
        sourceRef,
      });
      render(await page());
      expect(
        screen.queryByRole("link", { name: "openGithub" }),
      ).not.toBeInTheDocument();
      if (!sourceRef.startsWith("https:"))
        expect(
          screen.queryByRole("link", { name: sourceRef }),
        ).not.toBeInTheDocument();
      expect(screen.getByText(sourceRef)).toBeInTheDocument();
    },
  );
  it("links a valid non-GitHub import URL without incorrectly offering GitHub navigation", async () => {
    mocks.install.mockResolvedValue({
      ...base(),
      source: "github",
      sourceRef: "https://example.com/skill.md",
    });
    render(await page());
    expect(
      screen.getByRole("link", { name: "https://example.com/skill.md" }),
    ).toHaveAttribute("href", "https://example.com/skill.md");
    expect(
      screen.queryByRole("link", { name: "openGithub" }),
    ).not.toBeInTheDocument();
  });
  it("survives invalid bundled files while retaining the instructions", async () => {
    mocks.install.mockResolvedValue({
      ...base(),
      files: [{ path: "../../secret", content: "secret" }],
    });
    render(await page());
    expect(
      screen.getByText("noBundledFilesThisSkillSyncsAsASingleSkillmdFile"),
    ).toBeInTheDocument();
    expect(screen.getByText(/# Instructions/)).toBeInTheDocument();
    expect(screen.queryByText("secret")).not.toBeInTheDocument();
  });
  it.each([
    ["description: unquoted", "unquoted"],
    ['description: "quoted"', "quoted"],
    ["description: ''", "Database description"],
    ["other: value\nno separator", "Database description"],
  ])("resolves frontmatter description from %s", async (header, expected) => {
    mocks.install.mockResolvedValue({
      ...base(),
      content: `---\n${header}\n---\nBody`,
    });
    render(await page());
    expect(screen.getByText(expected)).toBeInTheDocument();
  });
  it.each([
    ["a".repeat(1100), "1.1 KB"],
    ["a".repeat(1024 * 1024), "1.0 MB"],
  ])("formats large instruction artifact sizes", async (content, size) => {
    mocks.install.mockResolvedValue({
      ...base(),
      content: `---\nname: writer\n---\n${content}`,
    });
    render(await page());
    expect(screen.getByText(size)).toBeInTheDocument();
  });
});
