"use client";

import { useCallback, useMemo } from "react";
import remarkBreaks from "remark-breaks";
import {
  defaultRehypePlugins,
  defaultRemarkPlugins,
  Streamdown,
  type StreamdownProps,
} from "streamdown";
import { harden } from "rehype-harden";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, {
  defaultSchema,
  type Options as SanitizeSchema,
} from "rehype-sanitize";

// Untrusted assistant and marketplace markdown must never mount executable HTML,
// even when a caller supplies extra allowed tags or custom renderers.
const BLOCKED_HTML = [
  "base",
  "embed",
  "iframe",
  "link",
  "meta",
  "object",
  "script",
  "style",
] as const;
const blockedTags: Record<string, true> = {
  base: true,
  embed: true,
  iframe: true,
  link: true,
  meta: true,
  object: true,
  script: true,
  style: true,
};
const blockedComponents = Object.fromEntries(
  BLOCKED_HTML.map((tag) => [tag, () => null]),
) as NonNullable<StreamdownProps["components"]>;
const softBreakPlugins = [...Object.values(defaultRemarkPlugins), remarkBreaks];
const sanitizeEntry: unknown = defaultRehypePlugins.sanitize;
const markdownSchema = (
  Array.isArray(sanitizeEntry) && sanitizeEntry[1]
    ? sanitizeEntry[1]
    : defaultSchema
) as SanitizeSchema;
const assistantRehypePlugins: NonNullable<StreamdownProps["rehypePlugins"]> = [
  rehypeRaw,
  [rehypeSanitize, markdownSchema],
  [
    harden,
    {
      allowedImagePrefixes: ["*"],
      allowedLinkPrefixes: ["*"],
      allowedProtocols: ["http", "https", "mailto"],
      allowDataImages: false,
    },
  ],
];

export type SafeStreamdownProps = StreamdownProps & {
  preserveSoftBreaks?: boolean;
  assistant?: boolean;
};

export function SafeStreamdown({
  allowElement,
  assistant = false,
  components,
  disallowedElements,
  preserveSoftBreaks = false,
  rehypePlugins,
  remarkPlugins,
  ...props
}: SafeStreamdownProps) {
  const safeComponents = useMemo(
    () => ({ ...components, ...blockedComponents }),
    [components],
  );
  const safeDisallowedElements = useMemo(
    () => [...new Set([...(disallowedElements ?? []), ...BLOCKED_HTML])],
    [disallowedElements],
  );
  const safeAllowElement = useCallback<
    NonNullable<StreamdownProps["allowElement"]>
  >(
    (element, index, parent) => {
      if (Object.hasOwn(blockedTags, element.tagName.toLowerCase()))
        return false;
      return allowElement?.(element, index, parent) ?? true;
    },
    [allowElement],
  );
  const effectiveRemarkPlugins = useMemo(
    () =>
      preserveSoftBreaks
        ? remarkPlugins
          ? [...remarkPlugins, remarkBreaks]
          : softBreakPlugins
        : remarkPlugins,
    [preserveSoftBreaks, remarkPlugins],
  );

  return (
    <Streamdown
      {...props}
      allowElement={safeAllowElement}
      components={safeComponents}
      disallowedElements={safeDisallowedElements}
      rehypePlugins={assistant ? assistantRehypePlugins : rehypePlugins}
      remarkPlugins={effectiveRemarkPlugins}
    />
  );
}
