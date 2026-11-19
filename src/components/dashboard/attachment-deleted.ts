import { apiRequest } from "@/lib/client/api";

/** Messages keep a deleted attachment's URL; its download then answers 404. */
export async function isDeletedAttachment(url: string): Promise<boolean> {
  if (!url.startsWith("/api/v1/attachments/")) return false;
  const result = await apiRequest(url, { method: "HEAD" });
  return !result.ok && result.status === 404;
}
