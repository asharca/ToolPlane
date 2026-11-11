import "server-only";
import { TaskNotFoundError } from "@a2a-js/sdk/errors";
import { resolveRequestPrincipal } from "@/lib/auth/request-user";
import { safeAttachmentFilename } from "@/lib/attachments/storage";
import { openWorkspaceTaskFile, openTaskFileCapability } from "./files";

function attachmentDisposition(filename: string): string {
  const fallback = safeAttachmentFilename(filename);
  const encoded = encodeURIComponent(filename.toWellFormed()).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** A file ticket is a scoped read capability, never a credential for another endpoint. */
export async function taskFileDownload(
  req: Request,
  fileId: string,
): Promise<Response> {
  const headers = {
    "Cache-Control": "private, no-store, max-age=0",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  };
  try {
    if (req.headers.has("origin") || req.headers.has("range"))
      return new Response(null, { status: 403, headers });
    const url = new URL(req.url);
    if (
      ["task", "expires", "signature"].some(
        (key) => url.searchParams.getAll(key).length !== 1,
      )
    )
      return new Response(null, { status: 404, headers });
    const { file, body } = await openTaskFileCapability(
      fileId,
      url.searchParams.get("task") ?? "",
      url.searchParams.get("expires") ?? "",
      url.searchParams.get("signature") ?? "",
    );
    return new Response(body, {
      headers: {
        ...headers,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(file.size),
        "Content-Disposition": attachmentDisposition(file.filename),
        ETag: `"sha256-${file.sha256}"`,
      },
    });
  } catch (error) {
    // Never include a source URL, signature, Docker path, or authorization failure detail.
    return new Response(null, {
      status: error instanceof TaskNotFoundError ? 404 : 503,
      headers,
    });
  }
}

/** Session-only workspace task observation; no transferable ticket or execution authority. */
export async function taskFileSessionDownload(
  req: Request,
  fileId: string,
): Promise<Response> {
  const headers = {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    Vary: "Cookie, Authorization",
  };
  try {
    const site = req.headers.get("sec-fetch-site");
    if (site && !["same-origin", "none"].includes(site))
      return new Response(null, { status: 403, headers });
    if (req.headers.has("authorization"))
      return new Response(null, { status: 401, headers });
    const principal = await resolveRequestPrincipal(req);
    if (principal?.credential !== "session")
      return new Response(null, { status: 401, headers });
    const query = new URL(req.url).searchParams;
    if (query.getAll("task").length !== 1) throw new TaskNotFoundError();
    const { file, body } = await openWorkspaceTaskFile(
      principal.user.id,
      query.get("task") ?? "",
      fileId,
    );
    return new Response(body, {
      headers: {
        ...headers,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(file.size),
        "Content-Disposition": attachmentDisposition(file.filename),
      },
    });
  } catch (error) {
    return new Response(null, {
      status: error instanceof TaskNotFoundError ? 404 : 503,
      headers,
    });
  }
}
