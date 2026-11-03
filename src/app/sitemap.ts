import type { MetadataRoute } from "next";
import { siteOrigin } from "./(site)/_lib/metadata";

export const dynamic = "force-dynamic";

const STATIC_ROUTES = [
  "/",
  "/what-is-an-mcp-server",
  "/privacy",
  "/terms",
] as const;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = siteOrigin();
  const url = (path: string) => new URL(path, origin).toString();

  return [
    ...STATIC_ROUTES.map((path) => ({
      url: url(path),
      changeFrequency: path === "/" ? ("daily" as const) : ("weekly" as const),
      priority: path === "/" ? 1 : 0.7,
    })),
  ];
}
