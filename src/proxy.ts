import { NextResponse, type NextRequest } from "next/server";
import { resolveLocale } from "@/i18n/locale";
import { getTransportSettings } from "@/lib/admin/transport-settings";
import { securityHeaders } from "@/lib/http/security-headers";

export async function proxy(request: NextRequest) {
  const locale = resolveLocale(
    request.cookies.get("NEXT_LOCALE")?.value,
    request.headers.get("accept-language"),
  );
  const response = NextResponse.next();
  const { allowHttp } = await getTransportSettings();
  const allowSameOriginFrames = /^\/app\/[^/]+\/.+/.test(
    request.nextUrl.pathname,
  );
  for (const { key, value } of securityHeaders(
    process.env.NODE_ENV,
    allowSameOriginFrames,
    allowHttp,
  ))
    response.headers.set(key, value);
  response.headers.set("Content-Language", locale);
  response.headers.set("Vary", "Accept-Language, Cookie");
  const forwardedProtocol = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  if (forwardedProtocol === "https" || request.nextUrl.protocol === "https:") {
    response.headers.set(
      "Strict-Transport-Security",
      allowHttp ? "max-age=0" : "max-age=31536000",
    );
  }
  return response;
}

export const config = {
  matcher: [
    "/((?!api(?:/|$)|_next(?:/|$)|favicon\\.ico$|icon\\.svg$|opengraph-image(?:/|$)|robots\\.txt$|sitemap\\.xml$).*)",
  ],
};
