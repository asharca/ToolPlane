import "server-only";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type enMessages from "../../messages/en.json";
import type { Locale } from "./routing";

export type AppMessages = typeof enMessages;

type CachedMessages = {
  mtimeMs: number;
  size: number;
  messages: AppMessages;
};

const globalCache = globalThis as typeof globalThis & {
  __toolplaneI18nCache?: Map<Locale, CachedMessages>;
};
const cache =
  globalCache.__toolplaneI18nCache ?? new Map<Locale, CachedMessages>();
globalCache.__toolplaneI18nCache = cache;

export function loadMessages(locale: Locale): AppMessages {
  const cached = cache.get(locale);
  if (process.env.NODE_ENV === "production" && cached) {
    return cached.messages;
  }
  const filePath = path.join(
    process.cwd(),
    "messages",
    locale === "zh" ? "zh.json" : "en.json",
  );
  if (process.env.NODE_ENV !== "production") {
    const stat = statSync(filePath);
    if (
      cached &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.size === stat.size
    ) {
      return cached.messages;
    }
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as AppMessages;
    cache.set(locale, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      messages: parsed,
    });
    return parsed;
  }
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as AppMessages;
  cache.set(locale, { mtimeMs: 0, size: 0, messages: parsed });
  return parsed;
}
