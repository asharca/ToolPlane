import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocsShell } from "@/app/docs/docs-shell";

const navigation = vi.hoisted(() => ({
  pathname: "/docs/en/guides/start",
  push: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({
    push: navigation.push,
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));
const docs = [
  {
    url: "/docs/en/guides/start",
    title: "Getting started",
    language: "en" as const,
    category: "guides" as const,
    topic: "getting-started",
  },
  {
    url: "/docs/zh/guides/start",
    title: "入门",
    language: "zh" as const,
    category: "guides" as const,
    topic: "getting-started",
  },
  {
    url: "/docs/en/guides/only-en",
    title: "English-only guide",
    language: "en" as const,
    category: "guides" as const,
    topic: "english-only",
  },
  {
    url: "/docs/en/developers/sdk",
    title: "Build an integration",
    language: "en" as const,
    category: "developers" as const,
    topic: "sdk",
  },
  {
    url: "/docs/zh/developers/sdk",
    title: "开发集成",
    language: "zh" as const,
    category: "developers" as const,
    topic: "sdk",
  },
  {
    url: "/docs/en/api/resources",
    title: "API resources",
    language: "en" as const,
    category: "api" as const,
    topic: "resources",
  },
  {
    url: "/docs/zh/api/resources",
    title: "接口资源",
    language: "zh" as const,
    category: "api" as const,
    topic: "resources",
  },
  {
    url: "/docs/en/guides/internal",
    title: "Internal README",
    language: "en" as const,
    category: "guides" as const,
    topic: "docs/README",
  },
];
beforeEach(() => {
  navigation.pathname = "/docs/en/guides/start";
  navigation.push.mockClear();
});

function mount() {
  return render(
    <DocsShell docs={docs}>
      <article>
        <h1>Current article</h1>
        <p>Article body stays available</p>
      </article>
    </DocsShell>,
  );
}

describe("documentation shell navigation", () => {
  it.each([
    ["/docs/en/guides/start", "Language", "zh", "/docs/zh/guides/start"],
    ["/docs/zh/guides/start", "语言", "en", "/docs/en/guides/start"],
    ["/docs/en/developers/sdk", "Language", "zh", "/docs/zh/developers/sdk"],
    ["/docs/en/guides/only-en", "Language", "zh", "/docs/zh/guides"],
    ["/docs/en/developers/missing", "Language", "zh", "/docs/zh/developers"],
    ["/docs/en/api/missing", "Language", "zh", "/docs/zh/api"],
    ["/docs/en", "Language", "zh", "/docs/zh"],
    ["/docs/zh", "语言", "en", "/docs/en"],
    ["/docs/en/unknown/missing", "Language", "zh", "/docs/zh/guides"],
  ])(
    "switches %s using its matching translated topic or category fallback",
    (path, label, language, expected) => {
      navigation.pathname = path;
      mount();
      fireEvent.change(screen.getByRole("combobox", { name: label }), {
        target: { value: language },
      });
      expect(navigation.push).toHaveBeenCalledWith(expected);
      expect(
        screen.getByRole("heading", { name: "Current article" }),
      ).toBeInTheDocument();
    },
  );

  it.each([
    ["en", "guides", "User guides", "Getting started", "Build an integration"],
    [
      "en",
      "developers",
      "Developers",
      "Build an integration",
      "Getting started",
    ],
    ["en", "api", "API reference", "API resources", "Getting started"],
    ["zh", "guides", "用户文档", "入门", "开发集成"],
    ["zh", "developers", "开发者文档", "开发集成", "入门"],
    ["zh", "api", "API 文档", "接口资源", "入门"],
  ])(
    "shows only %s %s sidebar documents and keeps the API entry external to the docs tree",
    (language, category, sectionLabel, included, excluded) => {
      navigation.pathname = `/docs/${language}/${category}/page`;
      const { container } = mount();
      const sectionNav = screen.getByRole("navigation", {
        name: language === "en" ? "Documentation sections" : "文档分类",
      });
      expect(
        within(sectionNav).getByRole("link", { name: sectionLabel }),
      ).toHaveAttribute("aria-current", "page");
      expect(
        within(sectionNav).getByRole("link", {
          name: language === "en" ? "API reference" : "API 文档",
        }),
      ).toHaveAttribute("href", "/docs-api");
      expect(
        screen.getAllByRole("link", { name: included }).length,
      ).toBeGreaterThan(0);
      expect(
        screen.queryByRole("link", { name: excluded }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("link", { name: "Internal README" }),
      ).not.toBeInTheDocument();
      expect(container.querySelector(".docs-site")).toHaveAttribute(
        "lang",
        language === "en" ? "en" : "zh-CN",
      );
      if (category === "api")
        expect(
          screen.getByRole("link", {
            name:
              language === "en"
                ? "Interactive API reference"
                : "交互式接口参考（独立站）",
          }),
        ).toHaveAttribute("href", "/docs-api");
    },
  );

  it.each([
    "/docs/en",
    "/docs/en/api/reference",
    "/docs/zh",
    "/docs/zh/api/reference",
  ])(
    "omits the sidebar on %s while retaining the document and language switch",
    (path) => {
      navigation.pathname = path;
      mount();
      expect(
        screen.queryByRole("link", { name: "Getting started" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("link", { name: "API resources" }),
      ).not.toBeInTheDocument();
      expect(screen.getByText("Article body stays available")).toBeVisible();
      expect(screen.getByRole("combobox")).toHaveValue(
        path.includes("/en") ? "en" : "zh",
      );
    },
  );
});
