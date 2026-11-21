"use server";

import { probeRemoteDrafts } from "@/lib/remote-mcp/probe";
import { isPackagedStdioCommand } from "@/lib/process/mcp-runtime-target";
import { actionScope } from "./action-scope";
import {
  analyzePreset,
  analyzeText,
  IntakeError,
  type IntakeEntry,
} from "./mcp-intake";
import { createIntakeDeployments } from "./mcp-intake-creation";
import { registryEntry, searchRegistry } from "./mcp-registry";
import type {
  McpIntakeResult,
  McpIntakeSource,
  McpIntakeCreateItem,
  McpIntakeCreateResult,
  McpRegistrySearchResult,
} from "./mcp-intake-types";

async function analyze(source: McpIntakeSource) {
  let entries: IntakeEntry[];
  switch (source?.kind) {
    case "text":
      entries = analyzeText(source.text);
      break;
    case "preset":
      entries = [analyzePreset(source.presetId)];
      break;
    case "registry":
      entries = [await registryEntry(source.name, source.version)];
      break;
    default:
      throw new IntakeError("unrecognized");
  }
  return entries;
}

function arbitrary(entries: IntakeEntry[]) {
  return entries.some(
    (entry) =>
      entry.draft.kind === "stdio" &&
      !isPackagedStdioCommand(JSON.parse(entry.draft.config).command),
  );
}

export async function analyzeMcpSourceAction(input: {
  workspace: string;
  source: McpIntakeSource;
}): Promise<McpIntakeResult> {
  const ctx = input && (await actionScope({ slug: input.workspace }));
  if (!ctx) return { ok: false, error: "notAuthorized" };
  try {
    const entries = await analyze(input.source);
    if (arbitrary(entries) && ctx.ws.role === "member")
      return { ok: false, error: "arbitraryCommandNotAllowed" };
    await probeRemoteDrafts(entries);
    return { ok: true, drafts: entries.map((entry) => entry.draft) };
  } catch (error) {
    if (error instanceof IntakeError) {
      switch (error.code) {
        case "invalidConfig":
        case "empty":
        case "unrecognized":
        case "tooManyServers":
        case "registryUnavailable":
        case "unsupportedRegistryEntry":
          return {
            ok: false,
            error: error.code,
            issue: error.issue && { code: error.issue.code },
          };
      }
    }
    return { ok: false, error: "invalidConfig" };
  }
}

export async function searchMcpRegistryAction(input: {
  workspace: string;
  query: string;
  cursor?: string;
}): Promise<McpRegistrySearchResult> {
  if (!input || !(await actionScope({ slug: input.workspace })))
    return { ok: false, error: "notAuthorized" };
  return searchRegistry(input.query, input.cursor);
}

export async function createMcpFromIntakeAction(input: {
  workspace: string;
  source: McpIntakeSource;
  items: McpIntakeCreateItem[];
}): Promise<McpIntakeCreateResult> {
  const ctx = input && (await actionScope({ slug: input.workspace }));
  if (!ctx) return { ok: false, error: "notAuthorized" };
  try {
    const entries = await analyze(input.source);
    if (arbitrary(entries)) {
      const manage = await actionScope({
        slug: input.workspace,
        capability: "manage",
      });
      if (!manage) return { ok: false, error: "arbitraryCommandNotAllowed" };
      await probeRemoteDrafts(entries);
      return await createIntakeDeployments(manage, entries, input.items);
    }
    await probeRemoteDrafts(entries);
    return await createIntakeDeployments(ctx, entries, input.items);
  } catch (error) {
    if (error instanceof IntakeError)
      return {
        ok: false,
        error: error.code,
        issue: error.issue && { code: error.issue.code },
      };
    return { ok: false, error: "connectionCreateFailed" };
  }
}
