import { withRequestLogging } from "@/lib/observability/http";
import { resolveRequestUser } from "@/lib/auth/request-user";
import { db } from "@/lib/db";
import {
  buildInstalledSkillMarkdown,
  installedSkillExtraFiles,
} from "@/lib/skills/artifact";
import { writeZip } from "@/lib/archives/zip";
import { skillLabel } from "@/lib/workspace/skill-label";
import { logRequest } from "@/lib/observability/log";

// Full portable bundle by default; ?format=markdown preserves the markdown API.
// Both formats use the same workspace-scoped account authorization.
export const GET = withRequestLogging(
  "/api/v1/skills/[installId]/download",
  async function GET(
    req: Request,
    { params }: { params: Promise<{ installId: string }> },
  ) {
    const start = Date.now();
    const { installId } = await params;

    const user = await resolveRequestUser(req);
    if (!user) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: {
          "content-type": "application/json",
          "cache-control": "private, no-store",
        },
      });
    }

    const install = await db.installedSkill.findFirst({
      where: {
        id: installId,
        workspace: {
          status: "active",
          OR: [
            { ownerId: user.id },
            { members: { some: { userId: user.id } } },
          ],
        },
      },
      include: {
        skill: {
          select: {
            slug: true,
            name: true,
            description: true,
            author: true,
            content: true,
            files: true,
          },
        },
        workspace: { select: { id: true } },
      },
    });
    if (!install) {
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: {
          "content-type": "application/json",
          "cache-control": "private, no-store",
        },
      });
    }

    const markdown = buildInstalledSkillMarkdown(install);
    const slug = skillLabel(install).slug;
    const format = new URL(req.url).searchParams.get("format") ?? "zip";
    if (format !== "zip" && format !== "markdown")
      return Response.json({ error: "invalid_format" }, { status: 400 });
    const artifact =
      format === "markdown"
        ? markdown
        : new Uint8Array(
            writeZip([
              { path: "SKILL.md", data: Buffer.from(markdown) },
              ...installedSkillExtraFiles(install).map((file) => ({
                path: file.path,
                data: Buffer.from(
                  file.content,
                  file.encoding === "base64" ? "base64" : "utf8",
                ),
              })),
            ]),
          );

    await logRequest({
      workspaceId: install.workspace.id,
      method: "GET",
      path: `/skills/${slug}/download`,
      statusCode: 200,
      durationMs: Date.now() - start,
    });

    return new Response(artifact, {
      status: 200,
      headers: {
        "content-type":
          format === "markdown"
            ? "text/markdown; charset=utf-8"
            : "application/zip",
        "content-disposition": `attachment; filename="${slug}.${format === "markdown" ? "SKILL.md" : "zip"}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  },
);
