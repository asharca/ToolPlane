'use client';

import { useCallback, useMemo } from 'react';
import { Streamdown, type StreamdownProps } from 'streamdown';

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

export function SafeStreamdown({
  allowElement,
  components,
  disallowedElements,
  ...props
}: StreamdownProps) {
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

  return (
    <Streamdown
      {...props}
      allowElement={safeAllowElement}
      components={safeComponents}
      disallowedElements={safeDisallowedElements}
    />
  );
}
