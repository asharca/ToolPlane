import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import type enMessages from "../../messages/en.json";
import type { Locale } from "./routing";

export type AppMessages = typeof enMessages;

const cache = new Map<Locale, AppMessages>();

export function loadMessages(locale: Locale): AppMessages {
  if (process.env.NODE_ENV === "production") {
    const cached = cache.get(locale);
    if (cached) return cached;
  }
  const filePath = path.join(
    process.cwd(),
    "messages",
    locale === "zh" ? "zh.json" : "en.json",
  );
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as AppMessages;
  if (process.env.NODE_ENV === "production") cache.set(locale, parsed);
  return parsed;
}
