import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import type { Locale } from "./routing";
import { resolveLocale } from "./locale";
import { loadMessages } from "./messages";

export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const headerStore = await headers();

  const locale: Locale = resolveLocale(
    cookieStore.get("NEXT_LOCALE")?.value,
    headerStore.get("accept-language"),
  );

  return {
    locale,
    messages: loadMessages(locale),
  };
});
