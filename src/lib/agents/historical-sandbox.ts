import "server-only";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { parseJson } from "./public-api/body";
import {
  readHistoricalSandboxVolume,
  sandboxVolumeName,
} from "@/lib/sandboxes/runtime";

export type HistoricalSandboxFileSource = {
  id: string;
  kind: string;
  deployment: { installCfg: Prisma.JsonValue | null };
};
const requestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string().max(240), z.number().finite(), z.null()]).optional(),
  method: z.literal("tools/call"),
  params: z.object({
    name: z.enum(["list_dir", "read_file", "download_file"]),
    arguments: z
      .object({ path: z.string().max(4_000).default(".") })
      .default({ path: "." }),
  }),
});

/** Retained volumes are mounted read-only in an offline helper, never an old Agent runtime. */
export async function serveHistoricalSandboxFiles(
  req: Request,
  path: string[],
  sandbox: HistoricalSandboxFileSource | null | undefined,
): Promise<Response> {
  if (req.method !== "POST" || path.length !== 1 || path[0] !== "rpc")
    return Response.json(
      {
        error:
          "Historical Agent workspaces are read-only; terminals are retired.",
      },
      { status: 410 },
    );
  const parsed = await parseJson(req, requestSchema, 1_000_000);
  if (!parsed.ok)
    return Response.json(
      {
        error:
          "Historical Agent workspaces allow only file listing, reading and download.",
      },
      { status: parsed.reason === "too_large" ? 413 : 410 },
    );
  if (!sandbox || (sandbox.kind !== "docker" && sandbox.kind !== "hermes"))
    return Response.json(
      { error: "Historical workspace is unavailable." },
      { status: 404 },
    );
  const rpc = parsed.value;
  const config = sandbox.deployment.installCfg;
  const volumeName =
    config &&
    typeof config === "object" &&
    !Array.isArray(config) &&
    typeof config.volumeName === "string"
      ? config.volumeName
      : sandboxVolumeName(sandbox.id);
  try {
    const result = await readHistoricalSandboxVolume(volumeName, {
      operation: rpc.params.name,
      path: rpc.params.arguments.path,
      ...(sandbox.kind === "hermes" ? { root: "workspace" as const } : {}),
    });
    return Response.json({
      jsonrpc: "2.0",
      id: rpc.id ?? null,
      result: { content: [{ type: "text", text: JSON.stringify(result) }] },
    });
  } catch {
    return Response.json({
      jsonrpc: "2.0",
      id: rpc.id ?? null,
      result: {
        isError: true,
        content: [{ type: "text", text: "Historical file is unavailable." }],
      },
    });
  }
}
