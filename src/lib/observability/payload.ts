export type PayloadPolicy =
  | "metadata-only"
  | "diagnostic"
  | "agent-content"
  | "request-response"
  | "forbidden";
/** Reads a finite response copy without a byte budget or a lossy deadline. */
export async function readResponseText(
  response: Response,
): Promise<string | null> {
  if (
    !response.body ||
    response.headers
      .get("content-type")
      ?.toLowerCase()
      .includes("text/event-stream")
  )
    return null;
  try {
    return await response.clone().text();
  } catch {
    return null;
  }
}
