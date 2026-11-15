import "server-only";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { db } from "@/lib/db";
import { createPiModel } from "@/lib/agents/model";
import { runtimeProviderUrl } from "@/lib/agents/runtime-access";
import {
  assertRuntimeOwner,
  runtimeAbortSignal,
  trackRuntimeOperation,
} from "@/lib/runtime/ownership-state";
import type { AgentRevisionConfig } from "@/lib/agents/revision-types";
import type { RuntimeUsage } from "@/lib/agents/runtime-commands";
import { EvolutionError } from "./errors";
import type { RecordedEvolutionTool } from "./contracts";
import { logSystemEvent } from "@/lib/observability/system";
import { z } from "zod";
import { agentRuntimeBuiltinToolGroups } from "@/lib/agents/runtime-kind";
import { PI_PACKAGE_CAPTURE_IMAGE } from "@/lib/agents/pi-version";
const nativeToolNames = agentRuntimeBuiltinToolGroups("pi-sdk").flatMap(
  (group) => group.tools,
);
export function evolutionNativeTools(disabledBuiltinTools: readonly string[]) {
  return nativeToolNames.filter((name) => !disabledBuiltinTools.includes(name));
}
const isolatedResultSchema = z
  .object({
    text: z.string().max(200_000),
    usage: z
      .object({
        inputTokens: z.number().nonnegative(),
        outputTokens: z.number().nonnegative(),
        cacheReadTokens: z.number().nonnegative(),
        cacheWriteTokens: z.number().nonnegative(),
      })
      .strict(),
    failed: z.boolean(),
    failureCode: z
      .enum([
        "TOOL_REPLAY_MISMATCH",
        "EVALUATION_UNSUPPORTED_CAPABILITY",
        "PI_EXECUTION_FAILED",
      ])
      .nullable()
      .optional(),
  })
  .strict();
const isolatedEventSchema = z.discriminatedUnion("type", [
  isolatedResultSchema.extend({ type: z.literal("result") }),
  z
    .object({
      type: z.literal("request"),
      id: z.number().int().positive(),
      path: z.string().min(1).max(2048),
      body: z.string().max(4_000_000),
    })
    .strict(),
]);
const providerRequestSchema = z.record(z.string(), z.json());
type IsolatedResult = z.infer<typeof isolatedResultSchema> & {
  executionImageId?: string;
};

class DockerOperationError extends Error {
  constructor(readonly reason: "not_found" | "failed") {
    super("PI_EVOLUTION_DOCKER_FAILED");
  }
}
function docker(args: string[], input?: string) {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const child = spawn("docker", args, {
    stdio: ["pipe", "pipe", "pipe"],
    signal: AbortSignal.timeout(30_000),
  });
  let output = "",
    stderr = "";
  child.stdout.on("data", (b) => {
    output += b;
    if (output.length > 100_000) child.kill("SIGKILL");
  });
  child.stderr.on("data", (b) => {
    if (stderr.length < 4096) stderr += b.toString();
  });
  child.on("error", () => reject(new DockerOperationError("failed")));
  child.on("close", (code) =>
    code === 0
      ? resolve(output)
      : reject(
          new DockerOperationError(
            /No such (container|object)/i.test(stderr) ? "not_found" : "failed",
          ),
        ),
  );
  child.stdin.end(input);
  return promise;
}
async function removeIsolatedContainer(name: string) {
  if (!/^toolplane-evolution-[a-f0-9-]{36}$/.test(name))
    throw new EvolutionError("FORBIDDEN");
  try {
    await docker(["rm", "-f", name]);
    return;
  } catch {}
  try {
    await docker(["inspect", name, "--format", "{{.Id}}"]);
  } catch (error) {
    if (error instanceof DockerOperationError && error.reason === "not_found")
      return;
    throw new EvolutionError("RUNTIME_UNAVAILABLE");
  }
  throw new EvolutionError("RUNTIME_UNAVAILABLE");
}
export function isolatedPi(input: {
  workspaceId: string;
  config: AgentRevisionConfig;
  prompt: string;
  systemPrompt?: string;
  recordedTools?: RecordedEvolutionTool[];
  requiredTools?: string[];
  identity?: { agentId: string; actorId: string; jobId: string };
  charge: (
    usage: RuntimeUsage,
    providerId: string,
    model: string,
    requestId: string,
  ) => Promise<void>;
  beforeRequest: () => Promise<void>;
}): Promise<IsolatedResult> {
  return trackRuntimeOperation(async () => {
    assertRuntimeOwner();
    if (
      input.config.runtimeKind !== "pi-sdk" ||
      !input.config.providerId ||
      !input.config.model
    )
      throw new EvolutionError("INVALID_REQUEST");
    const model = input.config.model;
    const provider = await db.modelProvider.findFirst({
      where: { id: input.config.providerId, workspaceId: input.workspaceId },
    });
    if (!provider?.apiKey) throw new EvolutionError("FORBIDDEN");
    const image = await docker([
      "image",
      "inspect",
      PI_PACKAGE_CAPTURE_IMAGE,
      "--format",
      "{{.Id}}",
    ]).then((v) => v.trim());
    if (!/^sha256:[a-f0-9]{64}$/.test(image))
      throw new EvolutionError("RUNTIME_UNAVAILABLE");
    const source = await readFile(
      join(process.cwd(), "scripts/pi-evolution-session.mjs"),
      "utf8",
    );
    const name = `toolplane-evolution-${randomUUID()}`;
    const isolated = input.identity
      ? await db.agentEvolutionRecord.create({
          data: {
            agentId: input.identity.agentId,
            workspaceId: input.workspaceId,
            actorId: input.identity.actorId,
            kind: "isolation-container",
            key: name,
            status: "running",
            payload: {
              containerName: name,
              jobId: input.identity.jobId,
              imageId: image,
            },
          },
        })
      : null;
    const timeout = AbortSignal.timeout(300_000),
      owner = runtimeAbortSignal();
    const signal = owner ? AbortSignal.any([owner, timeout]) : timeout;
    const child = spawn(
      "docker",
      [
        "run",
        "--rm",
        "-i",
        "--name",
        name,
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--user",
        "65534:65534",
        "--pids-limit",
        "128",
        "--memory",
        "1g",
        "--cpus",
        "1",
        "--tmpfs",
        "/workspace:rw,nosuid,nodev,size=268435456,mode=1777",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,nodev,size=67108864,mode=1777",
        "--workdir",
        "/workspace",
        "--env",
        "HOME=/workspace/agent",
        "--env",
        "XDG_CONFIG_HOME=/workspace/agent/config",
        "--env",
        "XDG_CACHE_HOME=/workspace/agent/cache",
        "--entrypoint",
        "node",
        image,
        "--input-type=module",
        "-e",
        source,
      ],
      { stdio: ["pipe", "pipe", "pipe"], signal },
    );
    let diagnostic = "";
    child.stderr.on("data", (bytes) => {
      if (diagnostic.length < 4096) diagnostic += bytes.toString();
    });
    let outcome:
      | { ok: true; value: IsolatedResult }
      | { ok: false; error: unknown };
    try {
      const { promise, resolve, reject } =
        Promise.withResolvers<IsolatedResult>();
      let result: IsolatedResult | undefined;
      let requests = 0,
        pending = Promise.resolve();
      const fail = (error: unknown) => {
        child.kill("SIGKILL");
        reject(
          error instanceof EvolutionError
            ? error
            : new EvolutionError("EVOLUTION_FAILED"),
        );
      };
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        if (line.length > 4_000_000) {
          fail(new EvolutionError("EVOLUTION_FAILED"));
          return;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          fail(new EvolutionError("EVOLUTION_FAILED"));
          return;
        }
        const parsed = isolatedEventSchema.safeParse(raw);
        if (!parsed.success) {
          fail(new EvolutionError("EVOLUTION_FAILED"));
          return;
        }
        const event = parsed.data;
        if (event.type === "result") {
          const { type, ...value } = event;
          result = value;
        }
        if (event.type !== "request") return;
        pending = pending
          .then(async () => {
            assertRuntimeOwner();
            await input.beforeRequest();
            const currentProvider = await db.modelProvider.findFirst({
              where: { id: provider.id, workspaceId: input.workspaceId },
            });
            if (!currentProvider || currentProvider.apiKey !== provider.apiKey)
              throw new EvolutionError("FORBIDDEN");
            if (++requests > input.config.maxSteps)
              throw new EvolutionError("BUDGET_EXCEEDED");
            const path = event.path;
            if (
              ![
                "/chat/completions",
                "/v1/chat/completions",
                "/messages",
                "/v1/messages",
                "/responses",
                "/v1/responses",
              ].includes(path)
            )
              throw new EvolutionError("FORBIDDEN");
            const body = providerRequestSchema.parse(JSON.parse(event.body));
            if (body.model !== model) throw new EvolutionError("FORBIDDEN");
            const tokenField = path.endsWith("/responses")
              ? "max_output_tokens"
              : Object.hasOwn(body, "max_completion_tokens")
                ? "max_completion_tokens"
                : "max_tokens";
            body[tokenField] = Math.min(Number(body[tokenField]) || 4096, 4096);
            const headers: Record<string, string> = {
              "content-type": "application/json",
              "accept-encoding": "identity",
            };
            if (provider.format === "anthropic") {
              headers["x-api-key"] = provider.apiKey;
              headers["anthropic-version"] = "2023-06-01";
            } else headers.authorization = `Bearer ${provider.apiKey}`;
            const response = await fetch(
              runtimeProviderUrl(
                provider.baseUrl,
                path.split("/").filter(Boolean),
              ),
              { method: "POST", headers, body: JSON.stringify(body), signal },
            );
            const text = (await response.text())
              .split(provider.apiKey)
              .join("[REDACTED]");
            if (text.length > 8_000_000)
              throw new EvolutionError("EVOLUTION_FAILED");
            const usage = extractUsage(text);
            await input.charge(
              usage,
              provider.id,
              model,
              `${name}:${event.id}`,
            );
            child.stdin.write(
              `${JSON.stringify({
                type: "response",
                id: event.id,
                status: response.status,
                contentType:
                  response.headers.get("content-type") ?? "application/json",
                body: Buffer.from(text).toString("base64"),
              })}\n`,
            );
          })
          .catch(fail);
      });
      child.on("error", fail);
      child.on("close", (code) => {
        void pending.then(() => {
          if (code === 0 && result)
            resolve({ ...result, executionImageId: image });
          else {
            logSystemEvent("agent.evolution.isolated_session_failed", {
              domain: "agent",
              errorCode: diagnostic.includes("ERR_MODULE_NOT_FOUND")
                ? "PI_EVOLUTION_MODULE_MISSING"
                : diagnostic.includes("TypeError")
                  ? "PI_EVOLUTION_SDK_ABI_FAILED"
                  : "PI_EVOLUTION_EXECUTION_FAILED",
            });
            fail(new EvolutionError("EVOLUTION_FAILED"));
          }
        });
      });
      child.stdin.write(
        `${JSON.stringify({
          type: "setup",
          model: createPiModel({ ...provider, apiKey: "" }, model),
          systemPrompt: input.systemPrompt ?? input.config.systemPrompt,
          skills: input.systemPrompt ? [] : input.config.skills,
          input: input.prompt,
          maxSteps: input.config.maxSteps,
          excludeTools: input.config.disabledBuiltinTools,
          nativeTools: evolutionNativeTools(input.config.disabledBuiltinTools),
          recordedTools: input.recordedTools ?? [],
          requiredTools: input.requiredTools ?? [],
        })}\n`,
      );
      outcome = { ok: true, value: await promise };
    } catch (error) {
      outcome = { ok: false, error };
    }
    child.stdin.destroy();
    let cleanupFailed = false;
    try {
      await removeIsolatedContainer(name);
      if (isolated) {
        await db.agentEvolutionRecord.update({
          where: { id: isolated.id },
          data: { status: "removed" },
        });
      }
    } catch {
      cleanupFailed = true;
      logSystemEvent("agent.evolution.isolated_cleanup_failed", {
        domain: "agent",
        errorCode: "ISOLATION_CLEANUP_FAILED",
      });
      if (isolated) {
        try {
          await db.agentEvolutionRecord.update({
            where: { id: isolated.id },
            data: {
              status: "cleanup_failed",
              failureCode: "ISOLATION_CLEANUP_FAILED",
            },
          });
        } catch {
          logSystemEvent("agent.evolution.isolated_cleanup_record_failed", {
            domain: "agent",
            errorCode: "ISOLATION_CLEANUP_RECORD_FAILED",
          });
        }
      }
    }
    if (!outcome.ok) throw outcome.error;
    if (cleanupFailed) throw new EvolutionError("RUNTIME_UNAVAILABLE");
    return outcome.value;
  });
}
const usageToken = z.number().finite().nonnegative().optional();
const providerUsageSchema = z
  .object({
    prompt_tokens: usageToken,
    input_tokens: usageToken,
    completion_tokens: usageToken,
    output_tokens: usageToken,
    cache_read_input_tokens: usageToken,
    cache_creation_input_tokens: usageToken,
    prompt_tokens_details: z
      .object({ cached_tokens: usageToken })
      .passthrough()
      .optional(),
    input_tokens_details: z
      .object({ cached_tokens: usageToken })
      .passthrough()
      .optional(),
  })
  .passthrough();
const providerEnvelopeSchema = z
  .object({
    usage: providerUsageSchema.optional(),
    message: z
      .object({ usage: providerUsageSchema.optional() })
      .passthrough()
      .optional(),
    response: z
      .object({ usage: providerUsageSchema.optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
export function extractUsage(text: string): RuntimeUsage {
  const result: RuntimeUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  const values: unknown[] = [];
  try {
    values.push(JSON.parse(text));
  } catch {
    for (const line of text.split("\n")) {
      if (line.startsWith("data: "))
        try {
          values.push(JSON.parse(line.slice(6)));
        } catch {}
    }
  }
  for (const value of values) {
    const envelope = providerEnvelopeSchema.safeParse(value);
    if (!envelope.success) continue;
    const obj = envelope.data,
      usage = obj.usage ?? obj.message?.usage ?? obj.response?.usage;
    if (!usage) continue;
    const cached =
      usage.cache_read_input_tokens ??
      usage.prompt_tokens_details?.cached_tokens ??
      usage.input_tokens_details?.cached_tokens ??
      0;
    const rawInput = usage.prompt_tokens ?? usage.input_tokens ?? 0;
    const input =
      usage.cache_read_input_tokens === undefined
        ? Math.max(0, rawInput - cached)
        : rawInput;
    result.inputTokens = Math.max(result.inputTokens, input);
    result.outputTokens = Math.max(
      result.outputTokens,
      usage.completion_tokens ?? usage.output_tokens ?? 0,
    );
    result.cacheReadTokens = Math.max(result.cacheReadTokens, cached);
    result.cacheWriteTokens = Math.max(
      result.cacheWriteTokens,
      usage.cache_creation_input_tokens ?? 0,
    );
  }
  return result;
}

export async function cleanupEvolutionContainers() {
  assertRuntimeOwner();
  const rows = await db.agentEvolutionRecord.findMany({
    where: {
      kind: "isolation-container",
      status: { in: ["running", "cleanup_failed"] },
    },
    take: 50,
    orderBy: { createdAt: "asc" },
  });
  for (const row of rows) {
    const value = z
      .object({
        containerName: z.string(),
        jobId: z.string(),
        imageId: z.string(),
      })
      .strict()
      .parse(row.payload);
    const job = await db.agentEvolutionRecord.findFirst({
      where: {
        id: value.jobId,
        agentId: row.agentId,
        workspaceId: row.workspaceId,
        kind: { in: ["evaluation", "reflection"] },
      },
    });
    if (
      job?.status === "running" &&
      job.leaseExpiresAt &&
      job.leaseExpiresAt > new Date()
    )
      continue;
    await removeIsolatedContainer(value.containerName);
    await db.agentEvolutionRecord.update({
      where: { id: row.id },
      data: { status: "removed", failureCode: null },
    });
  }
}
