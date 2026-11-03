import "server-only";
import { db } from "@/lib/db";
import { decryptSecretText, encryptSecretText } from "@/lib/security/secrets";
import { mcpDefinitionChecksum } from "./mcp-definition";
import { resolveSpawnSpec } from "./spawn-spec";
import { missingDeploymentRequiredEnvironment } from "@/lib/workspace/server-recipe";

function config(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function environment(value: unknown): Record<string, string> {
  const raw = config(value);
  if (
    Object.entries(raw).some(
      ([key, value]) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string",
    )
  )
    throw new Error("MCP_CREDENTIAL_INVALID");
  return raw as Record<string, string>;
}

/** Explicit private access only. Public serializers must never call this helper. */
export function resolveMcpEnvironment(
  installCfg: unknown,
  workspaceId: string,
): Record<string, string> {
  const cfg = config(installCfg);
  const seeds = environment(cfg.env);
  if (Object.values(seeds).some((value) => value !== ""))
    throw new Error("MCP_CREDENTIAL_MIGRATION_REQUIRED");
  if (!cfg.credentialEnvelope) return seeds;
  const envelope = config(cfg.credentialEnvelope);
  let payload: Record<string, unknown>;
  try {
    payload = config(JSON.parse(decryptSecretText(envelope.encrypted)));
  } catch {
    throw new Error("MCP_CREDENTIAL_INVALID");
  }
  if (payload.workspaceId !== workspaceId)
    throw new Error("MCP_CREDENTIAL_SCOPE_INVALID");
  const env = environment(payload.env);
  if (
    JSON.stringify(Object.keys(env).sort()) !==
      JSON.stringify(Object.keys(seeds).sort()) ||
    JSON.stringify(
      Object.keys(env)
        .filter((key) => env[key].trim())
        .sort(),
    ) !==
      JSON.stringify(
        Array.isArray(envelope.configuredKeys)
          ? [...envelope.configuredKeys].sort()
          : [],
      )
  )
    throw new Error("MCP_CREDENTIAL_INVALID");
  return env;
}

/** Persist encrypted values and key-only seeds. Omitted env preserves ciphertext. */
export function sealMcpEnvironment(
  installCfg: unknown,
  workspaceId: string,
  values?: Record<string, string>,
): Record<string, unknown> {
  const cfg = { ...config(installCfg) };
  if (values === undefined && cfg.credentialEnvelope) {
    resolveMcpEnvironment(cfg, workspaceId);
    return cfg;
  }
  const env = environment(values ?? cfg.env);
  if (values === undefined && Object.values(env).some((value) => value !== ""))
    throw new Error("MCP_CREDENTIAL_MIGRATION_REQUIRED");
  return {
    ...cfg,
    env: Object.fromEntries(Object.keys(env).map((key) => [key, ""])),
    credentialEnvelope: {
      configuredKeys: Object.keys(env).filter((key) => env[key].trim()),
      encrypted: encryptSecretText(JSON.stringify({ workspaceId, env })),
    },
  };
}

/** Call only after authorizing this workspace operation; the row is scoped again here. */
export async function resolveMcpConnectionSpawnSpec(input: {
  workspaceId: string;
  deploymentId: string;
  expectedDefinitionChecksum?: string;
  rebuild?: boolean;
}) {
  const deployment = await db.deployment.findFirst({
    where: { id: input.deploymentId, workspaceId: input.workspaceId },
    include: { server: { select: { name: true } } },
  });
  if (!deployment) throw new Error("MCP_CONNECTION_UNAVAILABLE");
  if (
    input.expectedDefinitionChecksum !== undefined &&
    mcpDefinitionChecksum(deployment) !== input.expectedDefinitionChecksum
  )
    throw new Error("MCP_DEFINITION_CHANGED");
  const env = resolveMcpEnvironment(deployment.installCfg, input.workspaceId);
  if (missingDeploymentRequiredEnvironment(deployment.installCfg).length)
    throw new Error("MCP_CREDENTIAL_REQUIRED");
  const spec = resolveSpawnSpec(
    { ...deployment, installCfg: { ...config(deployment.installCfg), env } },
    input.rebuild,
  );
  return { spec, redactionValues: Object.values(env).filter(Boolean) };
}
