"use client";

import { SafeStreamdown } from "@/components/dashboard/SafeStreamdown";
import { code } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";
import { resolveDocLink } from "@/lib/docs-links";
import { defaultRemarkPlugins } from "streamdown";
import { remarkHeading } from "fumadocs-core/mdx-plugins/remark-heading";

type MarkdownNode = { type?: string; url?: string; children?: MarkdownNode[] };

function documentLinks({
  file,
  links,
}: {
  file: string;
  links: { file: string; url: string }[];
}) {
  return function visit(node: MarkdownNode) {
    if (node.url) {
      node.url = resolveDocLink(file, node.url, links);
      if (
        (node.url.startsWith("/docs/") || node.url.startsWith("#")) &&
        !node.url.includes("#user-content-")
      ) {
        node.url = node.url.replace("#", "#user-content-");
      }
      if (node.type === "image")
        node.url = node.url.replace(
          "https://github.com/asharca/ToolPlane/blob/main/",
          "https://raw.githubusercontent.com/asharca/ToolPlane/main/",
        );
    }
    node.children?.forEach(visit);
  };
}

export function DocumentContent({
  content,
  file,
  links,
}: {
  content: string;
  file: string;
  links: { file: string; url: string }[];
}) {
  return (
    <SafeStreamdown
      mode="static"
      className="docs-content"
      plugins={{ code, mermaid }}
      components={{
        a: ({ href, children, node: _node, ...props }) => (
          <a
            {...props}
            href={href}
            target={
              href?.startsWith("/") || href?.startsWith("#")
                ? undefined
                : "_blank"
            }
          >
            {children}
          </a>
        ),
      }}
      remarkPlugins={[
        ...Object.values(defaultRemarkPlugins),
        remarkHeading,
        [documentLinks, { file, links }],
      ]}
    >
      {content}
    </SafeStreamdown>
  );
}
