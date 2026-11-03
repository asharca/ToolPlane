"use client";

import { SafeStreamdown } from "@/components/dashboard/SafeStreamdown";
import { useMemo } from "react";
import { defaultRehypePlugins, type StreamdownProps } from "streamdown";
import { harden } from "rehype-harden";

/** README contents are untrusted, version-pinned package data. */
export function PluginReadme({
  text,
  sourceUrl,
}: {
  text: string;
  sourceUrl?: string;
}) {
  const rehypePlugins = useMemo<StreamdownProps["rehypePlugins"]>(
    () => [
      defaultRehypePlugins.raw,
      defaultRehypePlugins.sanitize,
      [
        harden,
        {
          defaultOrigin: sourceUrl,
          allowedLinkPrefixes: ["*"],
          allowedImagePrefixes: ["*"],
          allowedProtocols: ["http", "https", "mailto"],
          allowDataImages: false,
        },
      ],
    ],
    [sourceUrl],
  );
  return (
    <div className="prose prose-sm min-w-0 max-w-none break-words dark:prose-invert [&_pre]:overflow-x-auto">
      <SafeStreamdown
        mode="static"
        rehypePlugins={rehypePlugins}
        urlTransform={(value, key) => {
          try {
            const url = sourceUrl ? new URL(value, sourceUrl) : new URL(value);
            return [
              "https:",
              "http:",
              ...(key === "href" ? ["mailto:"] : []),
            ].includes(url.protocol)
              ? key === "src"
                ? url.href.replace(
                    /^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\//,
                    "https://raw.githubusercontent.com/$1/",
                  )
                : url.href
              : "";
          } catch {
            return "";
          }
        }}
        components={{
          a: ({ href, children }) => {
            if (!href) return <span>{children}</span>;
            return (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            );
          },
        }}
      >
        {text}
      </SafeStreamdown>
    </div>
  );
}
