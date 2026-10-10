"use client";

import { usePathname, useRouter } from "next/navigation";
import { RootProvider } from "fumadocs-ui/provider/next";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { Doc } from "@/lib/docs-links";

export function DocsShell({
  docs,
  children,
}: {
  docs: Pick<Doc, "url" | "title" | "language" | "category" | "topic">[];
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const language = pathname.split("/")[2] === "en" ? "en" : "zh";
  const section = pathname.split("/")[3];
  const category =
    section === "developers" || section === "api" ? section : "guides";
  const zh = language === "zh";
  const base = `/docs/${language}`;
  const labels = zh
    ? { guides: "用户文档", developers: "开发者文档", api: "API 文档" }
    : { guides: "User guides", developers: "Developers", api: "API reference" };
  const categories = ["guides", "developers", "api"] as const;
  const current = docs.find((doc) => doc.url === pathname);
  const visible = docs.filter(
    (doc) =>
      doc.language === language &&
      doc.category === category &&
      doc.topic !== "docs/README",
  );
  return (
    <div className="docs-site" lang={zh ? "zh-CN" : "en"}>
      <header className="sticky top-0 z-50 flex h-28 flex-wrap items-center justify-between gap-x-4 border-b border-fd-border bg-fd-background px-5 py-3 sm:h-16 sm:flex-nowrap sm:px-6">
        <a href={base} className="font-semibold">
          {zh ? "ToolPlane 文档" : "ToolPlane Docs"}
        </a>
        <nav
          aria-label={zh ? "文档分类" : "Documentation sections"}
          className="order-3 flex w-full justify-center gap-5 text-sm sm:order-none sm:w-auto"
        >
          {categories.map((key) => (
            <a
              key={key}
              href={key === "api" ? "/docs-api" : `${base}/${key}`}
              aria-current={section === key ? "page" : undefined}
              className={
                section === key
                  ? "font-semibold text-fd-primary"
                  : "text-fd-muted-foreground"
              }
            >
              {labels[key]}
            </a>
          ))}
        </nav>
        <select
          aria-label={zh ? "语言" : "Language"}
          value={language}
          className="rounded-md border border-fd-border bg-fd-background px-3 py-1 text-sm"
          onChange={(event) => {
            const next = event.target.value;
            const translation =
              current &&
              docs.find(
                (doc) => doc.language === next && doc.topic === current.topic,
              );
            router.push(
              translation?.url ??
                `/docs/${next}${section ? `/${category}` : ""}`,
            );
          }}
        >
          <option value="zh">中文</option>
          <option value="en">English</option>
        </select>
      </header>
      <RootProvider
        key={`${language}/${category}`}
        theme={{ enabled: false }}
        i18n={{
          locale: language,
          translations: zh
            ? {
                "Search(search trigger)": "搜索文档",
                "Open Search(search trigger)(aria-label)": "搜索文档",
                "Search(search dialog)": "搜索文档",
                "No results found(search dialog)": "没有找到相关文档",
                "Close Search(search dialog)(aria-label)": "关闭搜索",
                "On this page(table of contents)": "本页目录",
                "Next Page(pagination)": "下一页",
                "Previous Page(pagination)": "上一页",
                "Open Sidebar(sidebar)(aria-label)": "打开目录",
                "Close Sidebar(sidebar)(aria-label)": "关闭目录",
                "Collapse Sidebar(sidebar)(aria-label)": "收起目录",
                "Toggle Theme(theme switcher)(aria-label)": "切换主题",
                "Light(theme switcher)(aria-label)": "浅色",
                "Dark(theme switcher)(aria-label)": "深色",
                "System(theme switcher)(aria-label)": "跟随系统",
              }
            : undefined,
        }}
        search={{
          options: {
            type: "static",
            api: "/docs/search",
            defaultTag: category,
          },
        }}
      >
        <DocsLayout
          nav={{ title: zh ? "ToolPlane 文档" : "ToolPlane Docs", url: base }}
          tabs={false}
          links={[
            { text: zh ? "返回 ToolPlane" : "Back to ToolPlane", url: "/" },
          ]}
          sidebar={{
            enabled: !!section && !pathname.endsWith("/api/reference"),
          }}
          tree={{
            name: labels[category],
            children: [
              {
                type: "page",
                name: zh ? "概览" : "Overview",
                url: `${base}/${category}`,
              },
              ...(category === "api"
                ? [
                    {
                      type: "page" as const,
                      name: zh
                        ? "交互式接口参考（独立站）"
                        : "Interactive API reference",
                      url: "/docs-api",
                    },
                  ]
                : []),
              ...visible.map((doc) => ({
                type: "page" as const,
                name: doc.title,
                url: doc.url,
              })),
            ],
          }}
        >
          {children}
        </DocsLayout>
      </RootProvider>
    </div>
  );
}
