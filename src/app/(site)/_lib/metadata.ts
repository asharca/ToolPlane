import type { Metadata } from "next";
import { SITE } from "@/lib/site";
import { runtimeEnv } from "@/lib/runtime-env";

const LOCAL_ORIGIN = "http://localhost:3000";

export function siteOrigin(): URL {
  const configured = runtimeEnv("NEXT_PUBLIC_APP_URL");
  try {
    return new URL(configured || LOCAL_ORIGIN);
  } catch {
    return new URL(LOCAL_ORIGIN);
  }
}

export function siteMetadata({
  title,
  description,
  path,
  index = true,
}: {
  title: string;
  description: string;
  path: string;
  index?: boolean;
}): Metadata {
  const canonical = path.startsWith("/") ? path : `/${path}`;

  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      type: "website",
      siteName: SITE.name,
      title,
      description,
      url: canonical,
      images: [
        {
          url: "/opengraph-image",
          width: 1200,
          height: 630,
          alt: `${SITE.name} preview`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ["/opengraph-image"],
    },
    robots: index
      ? { index: true, follow: true }
      : { index: false, follow: true, noarchive: true },
  };
}
