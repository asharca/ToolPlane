import "dotenv/config";
import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";
import messages from "./messages/en.json";

if (typeof window !== "undefined") {
  window.matchMedia ??= (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  });
  Element.prototype.scrollIntoView ??= () => {};
  globalThis.ResizeObserver ??= class implements ResizeObserver {
    private targets = new Set<Element>();
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.targets.add(target);
      queueMicrotask(() => {
        if (!this.targets.has(target)) return;
        const rect = target.getBoundingClientRect();
        const size = {
          inlineSize:
            rect.width ||
            (target instanceof HTMLElement
              ? Number.parseFloat(target.style.width) || 0
              : 0),
          blockSize:
            rect.height ||
            (target instanceof HTMLElement
              ? Number.parseFloat(target.style.height) || 0
              : 0),
        };
        this.callback(
          [
            {
              target,
              contentRect: rect,
              borderBoxSize: [size],
              contentBoxSize: [size],
              devicePixelContentBoxSize: [size],
            },
          ],
          this,
        );
      });
    }
    unobserve(target: Element) {
      this.targets.delete(target);
    }
    disconnect() {
      this.targets.clear();
    }
  };
}

function lookupMessage(path: string) {
  return path.split(".").reduce<unknown>((value, segment) => {
    if (!value || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[segment];
  }, messages);
}

function formatMessage(template: string, values?: Record<string, unknown>) {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    String(values[key] ?? `{${key}}`),
  );
}

vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  return {
    ...actual,
    useLocale: () => "en",
    useTranslations: (namespace?: string) =>
      Object.assign(
        (key: string, values?: Record<string, unknown>) => {
          const path = namespace ? `${namespace}.${key}` : key;
          const resolved = lookupMessage(path);
          if (typeof resolved === "string") {
            return formatMessage(resolved, values);
          }
          return key;
        },
        {
          has: (key: string) =>
            lookupMessage(namespace ? `${namespace}.${key}` : key) !==
            undefined,
        },
      ),
  };
});
