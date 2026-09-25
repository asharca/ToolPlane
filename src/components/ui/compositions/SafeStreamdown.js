// Application composition port from @asharca/ui@0.2.1 (MIT). See NOTICE.md.
'use client';
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
import { jsx as _jsx } from "react/jsx-runtime";
import { useCallback, useMemo } from 'react';
import remarkBreaks from 'remark-breaks';
import { defaultRemarkPlugins, Streamdown } from 'streamdown';
const BLOCKED_RAW_HTML_ELEMENTS = [
    'base',
    'embed',
    'iframe',
    'link',
    'meta',
    'object',
    'script',
    'style',
];
const BLOCKED_RAW_HTML_ELEMENT_SET = new Set(BLOCKED_RAW_HTML_ELEMENTS);
function BlockedRawHtmlElement() {
    return null;
}
const BLOCKED_RAW_HTML_COMPONENTS = Object.fromEntries(BLOCKED_RAW_HTML_ELEMENTS.map((tag) => [tag, BlockedRawHtmlElement]));
const SOFT_BREAK_REMARK_PLUGINS = [
    ...Object.values(defaultRemarkPlugins),
    remarkBreaks,
];
export function SafeStreamdown(_a) {
    var { allowElement, components, disallowedElements, preserveSoftBreaks = false, remarkPlugins } = _a, props = __rest(_a, ["allowElement", "components", "disallowedElements", "preserveSoftBreaks", "remarkPlugins"]);
    const safeComponents = useMemo(() => (Object.assign(Object.assign({}, components), BLOCKED_RAW_HTML_COMPONENTS)), [components]);
    const safeDisallowedElements = useMemo(() => {
        const tags = new Set(disallowedElements !== null && disallowedElements !== void 0 ? disallowedElements : []);
        BLOCKED_RAW_HTML_ELEMENTS.forEach((tag) => tags.add(tag));
        return Array.from(tags);
    }, [disallowedElements]);
    const safeAllowElement = useCallback((element, index, parent) => {
        var _a;
        if (BLOCKED_RAW_HTML_ELEMENT_SET.has(element.tagName.toLowerCase())) {
            return false;
        }
        return (_a = allowElement === null || allowElement === void 0 ? void 0 : allowElement(element, index, parent)) !== null && _a !== void 0 ? _a : true;
    }, [allowElement]);
    const effectiveRemarkPlugins = useMemo(() => {
        if (!preserveSoftBreaks)
            return remarkPlugins;
        return remarkPlugins ? [...remarkPlugins, remarkBreaks] : SOFT_BREAK_REMARK_PLUGINS;
    }, [preserveSoftBreaks, remarkPlugins]);
    return (_jsx(Streamdown, Object.assign({}, props, { allowElement: safeAllowElement, components: safeComponents, disallowedElements: safeDisallowedElements, remarkPlugins: effectiveRemarkPlugins })));
}
