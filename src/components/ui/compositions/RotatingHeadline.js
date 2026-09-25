// Application composition port from @asharca/ui@0.2.1 (MIT). See NOTICE.md.
'use client';
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
export function RotatingHeadline({ words }) {
    var _a, _b;
    const [wordIndex, setWordIndex] = useState(0);
    useEffect(() => {
        if (typeof window.matchMedia === 'function'
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            return;
        }
        const timers = words.slice(1).map((_, index) => window.setTimeout(() => setWordIndex(index + 1), (index + 1) * 950));
        return () => timers.forEach(window.clearTimeout);
    }, [words]);
    const activeWord = (_b = (_a = words[wordIndex]) !== null && _a !== void 0 ? _a : words[0]) !== null && _b !== void 0 ? _b : '';
    return (_jsxs("span", { "data-toolplane-ui": "rotating-headline", className: "relative inline-grid text-muted-foreground", children: [words.map((word) => (_jsx("span", { "aria-hidden": true, className: "invisible col-start-1 row-start-1", children: word }, word))), _jsx("span", { "aria-hidden": true, className: "tp-rotating-headline__word col-start-1 row-start-1", children: activeWord }, activeWord)] }));
}
