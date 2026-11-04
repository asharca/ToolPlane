import "server-only";
import { getTransportSettings } from "@/lib/admin/transport-settings";
import { createHmac, randomUUID } from "node:crypto";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requirePluginWorkspace } from "@/lib/plugins/catalog";
import {
  buildPrivatePluginManifest,
  intakePrivatePlugin,
} from "@/lib/plugins/local";
import {
  canonicalJson,
  marketReleaseChecksum,
} from "@/lib/pi-packages/artifact";
import { scanMarketArtifact } from "@/lib/pi-packages/secret-scan";
import type { PiPackageManifestV1 } from "@/lib/pi-packages/manifest";
import { readPluginSubagentMembers } from "@/lib/plugins/subagent-members";
import {
  parseUploadedSkillBundle,
  safeSkillFilePath,
} from "@/lib/skills/bundle";
import type { SkillBundleFile } from "@/lib/skills/bundle";
import { slugify } from "@/lib/skills/custom-skill";
import {
  parseCustomMcpInput,
  serializeMcpJsonConfig,
} from "@/lib/workspace/custom-mcp";
import type { ParsedCustomMcp } from "@/lib/workspace/custom-mcp";
import {
  sealMcpEnvironment,
  resolveMcpConnectionSpawnSpec,
} from "@/lib/process/mcp-credentials";
import { resolvePinnedMcpRecipe } from "@/lib/process/mcp-pinning";
import { prepareSessionMcpDefinition } from "@/lib/process/mcp-definition";
import { startProcess, stopProcess } from "@/lib/process/supervisor";
import { listMcpTools } from "@/lib/process/mcp-client";
import { withMcpToolCatalog } from "@/lib/process/mcp-tool-catalog";
import type { McpToolDefinition } from "@/lib/process/mcp-tool-catalog";
import { removeDeploymentContainer } from "@/lib/process/deployment-runtime-container";
import { removeDeploymentConfigVolume } from "@/lib/process/deployment-config-volume";
import { createConfiguredAgent } from "./mutations";
import { OmpImportRequestSchema } from "./omp-import-contract";
import type {
  OmpImportRequest,
  OmpImportPreview,
  OmpImportIssue,
} from "./omp-import-contract";
import {
  OMP_VERSION,
  emptyOmpConfig,
  OmpInstructionFilesSchema,
} from "./omp-config";
import { parseOmpConfigSnapshot } from "./omp-config-server";
import { agentRuntimeSupportsProviderFormat } from "./runtime-kind";
import type { PrivatePluginInput } from "./capability-contracts";
import { PrivatePluginInputSchema } from "./capability-contracts";
import { preflightOmpCapabilities } from "./omp-preflight";

export class OmpImportError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
  }
}
type Scope = { workspaceId: string; userId: string; slug: string };
type PreparedMcp = {
  id: string;
  name: string;
  source: ParsedCustomMcp["source"];
  sourceRef: string | null;
  installCfg: Record<string, unknown>;
  tools: McpToolDefinition[];
  runtimeIdentity: unknown;
};
const audience = "toolplane:omp-import";
function key() {
  if (!process.env.AUTH_SECRET)
    throw new OmpImportError("OMP_IMPORT_SIGNING_UNAVAILABLE", 503);
  return new TextEncoder().encode(process.env.AUTH_SECRET);
}
function identity(scope: Scope, input: OmpImportRequest) {
  const {
    confirmed: _confirmed,
    previewChecksum: _checksum,
    ...selection
  } = input;
  return createHmac("sha256", key())
    .update(canonicalJson({ scope, selection }))
    .digest("hex");
}
async function authorize(scope: Scope, tx: Prisma.TransactionClient = db) {
  await requirePluginWorkspace(scope.workspaceId, scope.userId, true, tx);
  const workspace = await tx.workspace.findFirst({
    where: { id: scope.workspaceId, slug: scope.slug, status: "active" },
    select: {
      id: true,
      ownerId: true,
      members: { where: { userId: scope.userId }, select: { role: true } },
    },
  });
  if (!workspace) throw new OmpImportError("OMP_IMPORT_NOT_AUTHORIZED", 403);
  return {
    ownerId: workspace.ownerId,
    role:
      workspace.ownerId === scope.userId ? "owner" : workspace.members[0]?.role,
  };
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function portable(value: unknown) {
  const text = JSON.stringify(value);
  if (
    /(?:\/home\/|\/Users\/|[A-Za-z]:\\\\|~\/)/.test(text) ||
    scanMarketArtifact(value).status !== "passed"
  )
    throw new OmpImportError("OMP_IMPORT_PRIVATE_DATA");
}
function targetPlugin(
  plugin: PrivatePluginInput,
  runtime: OmpImportRequest["runtimeKind"],
): PrivatePluginInput {
  if (plugin.runtimeKind === runtime) return plugin;
  const packageFile = plugin.files.find((file) => file.path === "package.json");
  if (runtime !== "pi-sdk" || !packageFile)
    throw new OmpImportError("OMP_IMPORT_PLUGIN_RUNTIME_INCOMPATIBLE");
  const metadata = record(
    JSON.parse(
      Buffer.from(
        packageFile.content,
        packageFile.encoding === "base64" ? "base64" : "utf8",
      ).toString("utf8"),
    ),
  );
  const declaration = record(metadata.pi);
  const nativeDeclaration = record(metadata.omp);
  const conflictingNativeDeclaration =
    metadata.omp !== undefined &&
    (Object.keys(nativeDeclaration).some((name) => name !== "extensions") ||
      canonicalJson(nativeDeclaration.extensions) !==
        canonicalJson(declaration.extensions));
  if (
    !metadata.pi ||
    conflictingNativeDeclaration ||
    plugin.hooks.length ||
    plugin.tools.length ||
    plugin.commands.length ||
    plugin.subagents?.length ||
    plugin.enabledFeatures?.length ||
    Object.keys(declaration).some((name) => name !== "extensions")
  )
    throw new OmpImportError("OMP_IMPORT_PLUGIN_RUNTIME_INCOMPATIBLE");
  const extensions = declaration.extensions;
  if (
    !Array.isArray(extensions) ||
    !extensions.length ||
    extensions.some((path) => typeof path !== "string")
  )
    throw new OmpImportError("OMP_IMPORT_PLUGIN_RUNTIME_INCOMPATIBLE");
  return PrivatePluginInputSchema.parse({
    ...plugin,
    runtimeKind: "pi-sdk",
    extensions,
  });
}
function mappedPlugin(
  input: OmpImportRequest,
  resource: OmpImportRequest["bundle"]["plugins"][number],
) {
  // Bundle bytes and source hints cannot supply workspace authorization.
  const { nativeRoleModels: _unreviewed, ...plugin } = resource.plugin;
  const mappings = input.roleModels?.[resource.id];
  return targetPlugin(
    {
      ...plugin,
      ...(mappings && Object.keys(mappings).length
        ? { nativeRoleModels: mappings }
        : {}),
    },
    input.runtimeKind,
  );
}
function parseSkill(skill: OmpImportRequest["bundle"]["skills"][number]) {
  const files: SkillBundleFile[] = [
    { path: "SKILL.md", content: skill.content },
    ...skill.files,
  ];
  if (
    new Set(files.map((file) => file.path.toLowerCase())).size !==
      files.length ||
    files.some((file) => safeSkillFilePath(file.path) !== file.path)
  )
    throw new OmpImportError("OMP_IMPORT_SKILL_INVALID");
  portable(files);
  for (const file of files) {
    if (
      /(?:^|\/)(?:\.env(?:\.[^/]*)?|auth\.[^/]*)(?:\/|$)/i.test(file.path) ||
      file.content.includes("\0")
    )
      throw new OmpImportError("OMP_IMPORT_SKILL_INVALID");
    if (file.encoding === "base64") {
      const bytes = Buffer.from(file.content, "base64");
      if (bytes.toString("base64") !== file.content)
        throw new OmpImportError("OMP_IMPORT_SKILL_INVALID");
      portable(bytes.toString("utf8"));
    }
  }
  const result = parseUploadedSkillBundle(files, skill.name, 1);
  if (result.files.length !== files.length - 1)
    throw new OmpImportError("OMP_IMPORT_SKILL_FILES_OMITTED");
  return result;
}
async function cleanupDeployment(id: string, workspaceId: string) {
  // A resource bound by another operation is no longer exclusively ours.
  const owned = await db.deployment.findFirst({
    where: {
      id,
      workspaceId,
      agentLinks: { none: {} },
      toolkitLinks: { none: {} },
      chatAssistantGrants: { none: {} },
    },
    select: { id: true },
  });
  if (!owned) return;
  await stopProcess(id);
  await removeDeploymentContainer(id);
  await removeDeploymentConfigVolume(id);
  await db.deployment.deleteMany({
    where: {
      id,
      workspaceId,
      agentLinks: { none: {} },
      toolkitLinks: { none: {} },
      chatAssistantGrants: { none: {} },
    },
  });
}
async function prepareMcp(
  scope: Scope,
  input: OmpImportRequest,
  server: OmpImportRequest["bundle"]["mcpServers"][number],
): Promise<PreparedMcp> {
  if (!input.inspectMcp)
    throw new OmpImportError("OMP_IMPORT_MCP_INSPECTION_APPROVAL_REQUIRED");
  const override = input.mcpConfigs?.[server.id];
  const config: Record<string, unknown> = { ...(override ?? server.config) };
  portable(config);
  // Absolute host commands must be mapped, not normalized into permission to run them.
  if (typeof config.command === "string" && /[/\\]/.test(config.command))
    throw new OmpImportError("OMP_IMPORT_MCP_PATH_MAPPING_REQUIRED");
  if (
    config.cwd !== undefined ||
    (!override &&
      /(?:^|[\s"=])\/(?!\/)/.test(JSON.stringify(config.args ?? [])))
  )
    throw new OmpImportError("OMP_IMPORT_MCP_PATH_MAPPING_REQUIRED");
  if (config.url !== undefined) {
    if (config.transport !== undefined) {
      config.type =
        config.transport === "sse"
          ? "sse"
          : config.transport === "http" ||
              config.transport === "streamable-http"
            ? "http"
            : config.transport;
      delete config.transport;
    }
    config.type ??= "http";
  } else if (config.type === "stdio") {
    delete config.type;
  }
  const environment = record(config.env);
  const supplied = input.mcpSecrets?.[server.id] ?? {};
  for (const value of Object.values(environment)) {
    if (
      typeof value !== "string" ||
      (value !== "" && !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value))
    )
      throw new OmpImportError("OMP_IMPORT_MCP_USE_SECRET_FIELDS");
  }
  // Header references are parsed by the shared custom-MCP policy, never interpolated.
  const headers = record(config.headers);
  if (
    Object.values(headers).some(
      (value) =>
        typeof value !== "string" ||
        !/^(?:Bearer )?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value),
    )
  )
    throw new OmpImportError("OMP_IMPORT_MCP_USE_SECRET_FIELDS");
  if (/\$\{/.test(JSON.stringify(config.args ?? [])))
    throw new OmpImportError("OMP_IMPORT_MCP_SECRET_ARGUMENT_UNSUPPORTED");
  const maskedArgs = record(JSON.parse(serializeMcpJsonConfig(config))).args;
  if (canonicalJson(maskedArgs) !== canonicalJson(config.args ?? []))
    throw new OmpImportError("OMP_IMPORT_MCP_SECRET_ARGUMENT_UNSUPPORTED");
  const env = Object.fromEntries(
    Object.entries(environment).map(([name, value]) => [
      name,
      typeof value === "string" && value
        ? (supplied[value.slice(2, -1)] ?? "")
        : "",
    ]),
  );
  if (config.env !== undefined) config.env = env;
  const parsed = parseCustomMcpInput(
    {
      source: "config",
      config: JSON.stringify({ mcpServers: { [server.name]: config } }),
      allowUnsafeHttp: override?.allowUnsafeHttp === true,
    },
    await getTransportSettings(),
  );
  const cfg = record(parsed.installCfg);
  const required = [
    ...new Set([
      ...server.requiredSecrets,
      ...Object.values(environment).flatMap((value) =>
        typeof value === "string" && value ? [value.slice(2, -1)] : [],
      ),
      ...(Array.isArray(cfg.requiredEnv) ? (cfg.requiredEnv as string[]) : []),
    ]),
  ];
  if (required.some((name) => !supplied[name]?.trim()))
    throw new OmpImportError("OMP_IMPORT_MCP_SECRETS_REQUIRED");
  const values = { ...record(cfg.env), ...supplied } as Record<string, string>;
  const pinned = await resolvePinnedMcpRecipe({
    source: parsed.source,
    sourceRef: parsed.ref,
    installCfg: sealMcpEnvironment(
      { ...cfg, requiredEnv: required },
      scope.workspaceId,
      values,
    ),
  });
  const runtimeIdentity = await prepareSessionMcpDefinition({
    serverId: null,
    name: server.name,
    source: parsed.source,
    sourceRef: pinned.sourceRef,
    installCfg: pinned.installCfg,
  });
  const candidate = {
    id: server.id,
    name: server.name,
    source: parsed.source,
    sourceRef: pinned.sourceRef,
    installCfg: record(pinned.installCfg),
    tools: [] as McpToolDefinition[],
    runtimeIdentity,
  };
  const dep = await db.deployment.create({
    data: {
      workspaceId: scope.workspaceId,
      serverId: null,
      name: server.name,
      source: candidate.source,
      sourceRef: candidate.sourceRef,
      installCfg: candidate.installCfg as Prisma.InputJsonValue,
      status: "provisioning",
    },
  });
  try {
    await authorize(scope);
    const { spec } = await resolveMcpConnectionSpawnSpec({
      workspaceId: scope.workspaceId,
      deploymentId: dep.id,
    });
    await startProcess(dep.id, spec, { workspaceId: scope.workspaceId });
    candidate.tools = await listMcpTools(dep.id, {
      persistCatalog: false,
      requireValidCatalog: true,
    });
    if (
      Object.values(supplied).some(
        (secret) => secret && JSON.stringify(candidate.tools).includes(secret),
      )
    )
      throw new OmpImportError("OMP_IMPORT_PRIVATE_DATA");
    portable(candidate.tools);
    return candidate;
  } finally {
    await cleanupDeployment(dep.id, scope.workspaceId);
  }
}
async function inspect(scope: Scope, input: OmpImportRequest) {
  const authority = await authorize(scope);
  portable(input.bundle);
  const excluded = new Set(input.excludedIds);
  const resources: OmpImportPreview["resources"] = [];
  const issues: OmpImportIssue[] = input.bundle.issues.map((issue) => ({
    ...issue,
  }));
  const mcps: PreparedMcp[] = [];
  const nativeRoles: NonNullable<OmpImportPreview["nativeRoles"]> = [];
  const roleNames = new Set<string>();
  const add = async (
    id: string,
    kind: OmpImportPreview["resources"][number]["kind"],
    name: string,
    validate: () => void | Promise<void>,
  ) => {
    const resource: OmpImportPreview["resources"][number] = {
      id,
      kind,
      name,
      status: excluded.has(id) ? "excluded" : "ready",
      messages: [],
    };
    if (resource.status !== "excluded") {
      try {
        await validate();
      } catch (error) {
        resource.status = "blocked";
        resource.messages.push(
          error instanceof OmpImportError
            ? error.code
            : `OMP_IMPORT_${kind.toUpperCase()}_INVALID_OR_UNAVAILABLE`,
        );
      }
      for (const issue of issues.filter(
        (issue) => issue.resourceId === id && issue.severity === "blocked",
      )) {
        if (
          kind === "mcp" &&
          input.mcpConfigs?.[id] &&
          resource.status === "ready" &&
          [
            "MCP_VALUE_REQUIRES_MAPPING",
            "MCP_EXECUTABLE_UNRESOLVED",
            "MCP_OPTION_UNSUPPORTED",
            "MCP_CONFIG_INVALID",
          ].includes(issue.code)
        )
          continue;
        resource.status = "blocked";
        resource.messages.push(issue.message);
      }
    }
    resources.push(resource);
    return resource;
  };
  await add("settings", "settings", "OMP settings", () => {
    if (
      input.runtimeKind === "pi-sdk" &&
      Object.keys(input.bundle.settings).length
    )
      throw new OmpImportError("OMP_IMPORT_PI_SETTINGS_INCOMPATIBLE");
    parseOmpConfigSnapshot({
      ...emptyOmpConfig(),
      settings: input.bundle.settings,
    });
  });
  await add("instructions", "instructions", "Instructions", () => {
    OmpInstructionFilesSchema.parse(input.bundle.instructions);
    parseOmpConfigSnapshot({
      ...emptyOmpConfig(),
      files: input.bundle.instructions,
    });
  });
  if (input.bundle.instructions.length)
    issues.push({
      id: "instruction-precedence",
      path: "instructions",
      code: "OMP_IMPORT_INSTRUCTIONS_APPEND",
      message:
        "Imported instructions, including SYSTEM.md, append to platform instructions; they do not replace the platform system prompt.",
      severity: "warning",
      resourceId: "instructions",
    });
  for (const skill of input.bundle.skills)
    await add(skill.id, "skill", skill.name, () => {
      parseSkill(skill);
    });
  for (const plugin of input.bundle.plugins) {
    const validated: { manifest?: PiPackageManifestV1 } = {};
    const resource = await add(
      plugin.id,
      "plugin",
      plugin.plugin.name,
      async () => {
        const manifest = buildPrivatePluginManifest(
          mappedPlugin(input, plugin),
        );
        const roles = readPluginSubagentMembers(manifest.package);
        let invalidModel = false;
        for (const role of roles) {
          const mapping = role.modelMapping;
          const modelHint =
            input.bundle.taskModelOverrides?.[role.name] ?? role.modelHint;
          nativeRoles.push({
            resourceId: plugin.id,
            path: role.path.slice("package/".length),
            name: role.name,
            modelHint,
            mapping,
          });
          if (roleNames.has(role.name))
            throw new OmpImportError("OMP_IMPORT_ROLE_NAME_CONFLICT");
          roleNames.add(role.name);
          if (!/^[A-Za-z0-9_-]{1,100}$/.test(role.name))
            throw new OmpImportError("OMP_IMPORT_ROLE_NAME_INVALID");
          if ((modelHint || role.definition.model) && !mapping)
            invalidModel = true;
          if (mapping) {
            const provider = await db.modelProvider.findFirst({
              where: { id: mapping.providerId, workspaceId: scope.workspaceId },
              select: { format: true, models: true },
            });
            if (
              !provider?.models.includes(mapping.model) ||
              !agentRuntimeSupportsProviderFormat(
                input.runtimeKind,
                provider.format,
              )
            )
              invalidModel = true;
          }
          if (
            role.definition.permissions.mcpTools.length ||
            role.definition.permissions.skillIds.length ||
            role.definition.permissions.pluginInstallIds?.length
          )
            throw new OmpImportError("OMP_IMPORT_ROLE_GRANTS_UNRESOLVED");
        }
        if (invalidModel)
          throw new OmpImportError("OMP_IMPORT_ROLE_MODEL_REQUIRED");
        validated.manifest = manifest;
      },
    );
    const manifest = validated.manifest;
    if (manifest && resource.status === "ready") {
      for (const [kind, paths] of Object.entries(manifest.package.resources))
        if (paths?.length)
          resource.messages.push(`${kind}: ${paths.join(", ")}`);
      if (manifest.package.resources.subagents?.length)
        issues.push({
          id: `${plugin.id}:roles`,
          path: plugin.id,
          resourceId: plugin.id,
          code: "OMP_IMPORT_ROLE_SCOPE",
          message:
            "Native role prompts retain explicitly mapped workspace models, or inherit the parent model when no source model is declared. Tools stay within the current Agent intersection. Platform native-task context, nesting and concurrency policy replaces local role policy; task model overrides are forbidden.",
          severity: "warning",
        });
      if (plugin.plugin.runtimeKind !== input.runtimeKind)
        resource.messages.push(
          "Explicit Pi extension declaration selected; the real Pi loader must pass before publication.",
        );
    }
  }
  for (const server of input.bundle.mcpServers) {
    const resource = await add(server.id, "mcp", server.name, async () => {
      mcps.push(await prepareMcp(scope, input, server));
    });
    resource.requiredSecrets = server.requiredSecrets;
    if (resource.status === "ready")
      resource.config = input.mcpConfigs?.[server.id] ?? server.config;
    resource.tools = mcps.find((mcp) => mcp.id === server.id)?.tools;
  }
  for (const issue of input.bundle.issues) {
    const id = issue.resourceId;
    if (!id || resources.some((resource) => resource.id === id)) continue;
    const kind = id.startsWith("plugin:")
      ? "plugin"
      : id.startsWith("skill:")
        ? "skill"
        : id.startsWith("mcp:")
          ? "mcp"
          : null;
    if (kind)
      await add(id, kind, issue.path || id, () => {
        throw new OmpImportError("OMP_IMPORT_SOURCE_RESOURCE_UNAVAILABLE");
      });
  }
  const known = new Set(resources.map((resource) => resource.id));
  if (
    input.excludedIds.some((id) => !known.has(id)) ||
    Object.keys(input.mcpConfigs ?? {}).some(
      (id) => !input.bundle.mcpServers.some((mcp) => mcp.id === id),
    ) ||
    Object.keys(input.mcpSecrets ?? {}).some(
      (id) => !input.bundle.mcpServers.some((mcp) => mcp.id === id),
    )
  )
    throw new OmpImportError("OMP_IMPORT_SELECTION_INVALID");
  if (
    Object.keys(input.roleModels ?? {}).some(
      (id) => !input.bundle.plugins.some((plugin) => plugin.id === id),
    )
  )
    throw new OmpImportError("OMP_IMPORT_SELECTION_INVALID");
  if (input.bundle.ompVersion !== OMP_VERSION)
    issues.push({
      id: "runtime-version",
      path: "ompVersion",
      code: "OMP_IMPORT_VERSION_DIFFERENT",
      message: `Source OMP version differs from pinned ${OMP_VERSION}; compatibility is not guaranteed.`,
      severity: "warning",
    });
  const provider = input.providerId
    ? await db.modelProvider.findFirst({
        where: { id: input.providerId, workspaceId: scope.workspaceId },
        select: { id: true, format: true, models: true },
      })
    : null;
  const modelValid =
    !!provider &&
    !!input.model &&
    provider.models.includes(input.model) &&
    agentRuntimeSupportsProviderFormat(input.runtimeKind, provider.format);
  if (!modelValid)
    issues.push({
      id: "model-selection",
      path: "model",
      code: "OMP_IMPORT_MODEL_REQUIRED",
      message: "Select an available workspace provider and model.",
      severity: "blocked",
    });
  if (
    resources.filter(
      (resource) => resource.kind === "plugin" && resource.status === "ready",
    ).length > 16
  )
    issues.push({
      id: "package-limit",
      path: "plugins",
      code: "OMP_IMPORT_PACKAGE_LIMIT",
      message:
        "An Agent can bind at most 16 plugin packages; explicitly exclude additional packages.",
      severity: "blocked",
    });
  const canImport =
    modelValid &&
    resources.every((resource) => resource.status !== "blocked") &&
    !issues.some(
      (issue) =>
        issue.severity === "blocked" &&
        (!issue.resourceId || !known.has(issue.resourceId)),
    );
  const plan = { resources, issues, model: input.bundle.model, nativeRoles };
  return {
    ...plan,
    mcps,
    authority,
    canImport,
    planChecksum: marketReleaseChecksum({
      plan,
      authority,
      recipes: mcps.map((mcp) => ({
        id: mcp.id,
        source: mcp.source,
        sourceRef: mcp.sourceRef,
        runtimeIdentity: mcp.runtimeIdentity,
      })),
    }),
  };
}
export async function previewOmpImport(
  scope: Scope,
  value: unknown,
): Promise<OmpImportPreview> {
  const input = OmpImportRequestSchema.parse(value);
  const plan = await inspect(scope, input);
  const checksum = await new SignJWT({
    identity: identity(scope, input),
    plan: plan.planChecksum,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("toolplane")
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(key());
  return {
    checksum,
    canImport: plan.canImport,
    resources: plan.resources,
    issues: plan.issues,
    model: plan.model,
    nativeRoles: plan.nativeRoles,
  };
}
export async function commitOmpImport(scope: Scope, value: unknown) {
  const input = OmpImportRequestSchema.parse(value);
  if (!input.confirmed || !input.previewChecksum)
    throw new OmpImportError("OMP_IMPORT_CONFIRMATION_REQUIRED");
  let receipt: JWTPayload;
  try {
    receipt = (
      await jwtVerify(input.previewChecksum, key(), {
        algorithms: ["HS256"],
        issuer: "toolplane",
        audience,
      })
    ).payload;
  } catch {
    throw new OmpImportError("OMP_IMPORT_PREVIEW_EXPIRED", 409);
  }
  if (receipt.identity !== identity(scope, input))
    throw new OmpImportError("OMP_IMPORT_PREVIEW_CHANGED", 409);
  const plan = await inspect(scope, input);
  if (receipt.plan !== plan.planChecksum)
    throw new OmpImportError("OMP_IMPORT_PREVIEW_CHANGED", 409);
  if (!plan.canImport) throw new OmpImportError("OMP_IMPORT_BLOCKED", 409);
  const selected = new Set(
    plan.resources
      .filter((resource) => resource.status === "ready")
      .map((resource) => resource.id),
  );
  const selectedPlugins = input.bundle.plugins
    .filter((plugin) => selected.has(plugin.id))
    .map((plugin) => {
      const manifest = buildPrivatePluginManifest(mappedPlugin(input, plugin));
      return {
        marketInstallId: plugin.id,
        releaseId: plugin.id,
        manifest,
        checksum: marketReleaseChecksum(manifest),
      };
    });
  if (input.runtimeKind === "omp")
    await preflightOmpCapabilities({
      piPackages: selectedPlugins,
      skills: input.bundle.skills
        .filter((skill) => selected.has(skill.id))
        .map((skill) => ({
          skillId: null,
          skill: null,
          name: skill.name,
          slug: slugify(skill.name),
          content: skill.content,
          files: skill.files,
        })),
      toolNames: plan.mcps.flatMap((mcp) => mcp.tools.map((tool) => tool.name)),
    });
  const ownedSkills: string[] = [],
    ownedDeployments: string[] = [],
    ownedListings: string[] = [],
    ownedInstalls: string[] = [];
  try {
    const prepared = await db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${scope.workspaceId} FOR UPDATE`;
        await authorize(scope, tx);
        const skillIds: string[] = [],
          deploymentIds: string[] = [],
          packages: Array<{ marketInstallId: string; releaseId: string }> = [];
        for (const skill of input.bundle.skills.filter((skill) =>
          selected.has(skill.id),
        )) {
          const bundle = parseSkill(skill);
          const row = await tx.installedSkill.create({
            data: {
              workspaceId: scope.workspaceId,
              source: "upload",
              name: skill.name,
              slug: `${slugify(skill.name).slice(0, 70)}-${randomUUID().slice(0, 8)}`,
              description: bundle.description,
              content: bundle.content,
              files: bundle.files,
              status: "published",
            },
          });
          skillIds.push(row.id);
        }
        for (const mcp of plan.mcps) {
          const row = await tx.deployment.create({
            data: {
              workspaceId: scope.workspaceId,
              name: mcp.name,
              source: mcp.source,
              sourceRef: mcp.sourceRef,
              installCfg: withMcpToolCatalog(
                mcp.installCfg,
                mcp.tools,
              ) as Prisma.InputJsonValue,
              status: "stopped",
            },
          });
          deploymentIds.push(row.id);
        }
        const listingsBefore = new Set(
          (
            await tx.marketListing.findMany({
              where: { publisherWorkspaceId: scope.workspaceId },
              select: { id: true },
            })
          ).map((row) => row.id),
        );
        const installsBefore = new Set(
          (
            await tx.marketInstall.findMany({
              where: { targetWorkspaceId: scope.workspaceId },
              select: { id: true },
            })
          ).map((row) => row.id),
        );
        for (const plugin of input.bundle.plugins.filter((plugin) =>
          selected.has(plugin.id),
        )) {
          const result = await intakePrivatePlugin(
            tx,
            scope.workspaceId,
            scope.userId,
            mappedPlugin(input, plugin),
            true,
          );
          packages.push({
            marketInstallId: result.installId,
            releaseId: result.releaseId,
          });
        }
        const listingIds = (
          await tx.marketListing.findMany({
            where: { publisherWorkspaceId: scope.workspaceId },
            select: { id: true },
          })
        )
          .filter((row) => !listingsBefore.has(row.id))
          .map((row) => row.id);
        return {
          skillIds,
          deploymentIds,
          packages,
          listingIds,
          installIds: packages
            .map((pkg) => pkg.marketInstallId)
            .filter((id) => !installsBefore.has(id)),
        };
      },
      { timeout: 30_000 },
    );
    ownedSkills.push(...prepared.skillIds);
    ownedDeployments.push(...prepared.deploymentIds);
    ownedListings.push(...prepared.listingIds);
    ownedInstalls.push(...prepared.installIds);
    const snapshot = parseOmpConfigSnapshot({
      ...emptyOmpConfig(),
      settings: selected.has("settings") ? input.bundle.settings : {},
      files: selected.has("instructions") ? input.bundle.instructions : [],
    });
    const agent = await createConfiguredAgent(
      scope.workspaceId,
      {
        name: input.name ?? input.bundle.name ?? "Imported OMP agent",
        systemPrompt:
          input.runtimeKind === "pi-sdk" && selected.has("instructions")
            ? input.bundle.instructions.map((file) => file.content).join("\n\n")
            : null,
        providerId: input.providerId ?? null,
        model: input.model ?? null,
        maxSteps: 50,
      },
      {
        installedSkillIds: prepared.skillIds,
        deploymentIds: prepared.deploymentIds,
        toolkitIds: [],
      },
      {
        runtime: input.runtimeKind,
        piPackages: prepared.packages,
        ompConfig: snapshot,
        enable: true,
        nativeSubagents: selectedPlugins.some(
          (plugin) => plugin.manifest.package.resources.subagents?.length,
        ),
        authorize: async (tx) => {
          const authority = await authorize(scope, tx);
          if (canonicalJson(authority) !== canonicalJson(plan.authority))
            throw new OmpImportError("OMP_IMPORT_PREVIEW_CHANGED", 409);
          if (
            receipt.identity !== identity(scope, input) ||
            Number(receipt.exp) * 1000 <= Date.now()
          )
            throw new OmpImportError("OMP_IMPORT_PREVIEW_EXPIRED", 409);
        },
      },
    );
    return { agentId: agent.id, href: `/app/${scope.slug}/agents/${agent.id}` };
  } catch (error) {
    for (const id of ownedDeployments)
      await cleanupDeployment(id, scope.workspaceId);
    await db.installedSkill.deleteMany({
      where: {
        id: { in: ownedSkills },
        workspaceId: scope.workspaceId,
        agentLinks: { none: {} },
        toolkitLinks: { none: {} },
      },
    });
    await db.marketInstall.deleteMany({
      where: {
        id: { in: ownedInstalls },
        targetWorkspaceId: scope.workspaceId,
        agentPiPackages: { none: {} },
        piSessionPackages: { none: {} },
      },
    });
    // Listing ownership alone is insufficient: another Agent may have bound it while preparation ran.
    for (const id of ownedListings)
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${scope.workspaceId} FOR UPDATE`;
        const listing = await tx.marketListing.findFirst({
          where: {
            id,
            publisherWorkspaceId: scope.workspaceId,
            installs: {
              every: {
                agentPiPackages: { none: {} },
                piSessionPackages: { none: {} },
              },
            },
          },
          select: { id: true },
        });
        if (listing) {
          await tx.marketInstall.deleteMany({
            where: { listingId: id, targetWorkspaceId: scope.workspaceId },
          });
          await tx.marketListing.update({
            where: { id },
            data: { latestReleaseId: null },
          });
          await tx.marketRelease.deleteMany({ where: { listingId: id } });
          await tx.marketListing.delete({ where: { id } });
        }
      });
    if (error instanceof OmpImportError) throw error;
    throw new OmpImportError("OMP_IMPORT_PREPARATION_FAILED", 422);
  }
}
