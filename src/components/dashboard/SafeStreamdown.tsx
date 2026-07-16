'use client';

import { useCallback, useMemo } from 'react';
import remarkBreaks from 'remark-breaks';
import { defaultRemarkPlugins, Streamdown, type StreamdownProps } from 'streamdown';

const BLOCKED_RAW_HTML_ELEMENTS = [
  'base',
  'embed',
  'iframe',
  'link',
  'meta',
  'object',
  'script',
  'style',
] as const;

const BLOCKED_RAW_HTML_ELEMENT_SET = new Set<string>(BLOCKED_RAW_HTML_ELEMENTS);

function BlockedRawHtmlElement() {
  return null;
}

const BLOCKED_RAW_HTML_COMPONENTS = Object.fromEntries(
  BLOCKED_RAW_HTML_ELEMENTS.map((tag) => [tag, BlockedRawHtmlElement]),
) as NonNullable<StreamdownProps['components']>;
const SOFT_BREAK_REMARK_PLUGINS = [
  ...Object.values(defaultRemarkPlugins),
  remarkBreaks,
];

type SafeStreamdownProps = StreamdownProps & {
  preserveSoftBreaks?: boolean;
};

export function SafeStreamdown({
  allowElement,
  components,
  disallowedElements,
  preserveSoftBreaks = false,
  remarkPlugins,
  ...props
}: SafeStreamdownProps) {
  const safeComponents = useMemo(
    () => ({ ...components, ...BLOCKED_RAW_HTML_COMPONENTS }),
    [components],
  );
  const safeDisallowedElements = useMemo(() => {
    const tags = new Set(disallowedElements ?? []);
    BLOCKED_RAW_HTML_ELEMENTS.forEach((tag) => tags.add(tag));
    return Array.from(tags);
  }, [disallowedElements]);
  const safeAllowElement = useCallback<NonNullable<StreamdownProps['allowElement']>>(
    (element, index, parent) => {
      if (BLOCKED_RAW_HTML_ELEMENT_SET.has(element.tagName.toLowerCase())) {
        return false;
      }
      return allowElement?.(element, index, parent) ?? true;
    },
    [allowElement],
  );
  const effectiveRemarkPlugins = useMemo(() => {
    if (!preserveSoftBreaks) return remarkPlugins;
    return remarkPlugins ? [...remarkPlugins, remarkBreaks] : SOFT_BREAK_REMARK_PLUGINS;
  }, [preserveSoftBreaks, remarkPlugins]);

  return (
    <Streamdown
      {...props}
      allowElement={safeAllowElement}
      components={safeComponents}
      disallowedElements={safeDisallowedElements}
      remarkPlugins={effectiveRemarkPlugins}
    />
  );
}
