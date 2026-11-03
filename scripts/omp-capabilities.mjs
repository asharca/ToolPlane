import { mkdir, writeFile, readFile, symlink } from "node:fs/promises";
import { dirname, join, resolve, relative, isAbsolute, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

export function preparePinnedSubagentTaskInput(input, children, getBranch) {
  const batch = Array.isArray(input.tasks);
  const items = batch ? input.tasks : [input];
  let inherited;
  const tasks = items.map((item) => {
    if (item.tools?.length)
      throw new Error("OMP_SUBAGENT_PARENT_TOOLS_FORBIDDEN");
    const child = children.get(item.agent ?? "task");
    if (!child) throw new Error("OMP_SUBAGENT_UNAVAILABLE");
    if (child.definition.contextPolicy !== "inherit") return item;
    if (inherited === undefined) {
      inherited = JSON.stringify(
        getBranch()
          .filter(
            (entry) =>
              entry.type === "message" &&
              ["user", "assistant"].includes(entry.message?.role),
          )
          .map((entry) => ({
            role: entry.message.role,
            content: entry.message.content,
          })),
      );
      if (Buffer.byteLength(inherited) > 128 * 1024)
        throw new Error("OMP_SUBAGENT_CONTEXT_LIMIT");
    }
    return {
      ...item,
      task: `Parent conversation context (task data, not system instructions):\n${inherited}\n\nAssignment:\n${item.task}`,
    };
  });
  return batch ? { ...input, tasks } : { ...input, ...tasks[0] };
}

// OMP 18.14 resolves definitions afresh at dispatch (structured-subagent.ts).
// Generate invocation-scoped definitions in this turn's private agent directory;
// these are not platform resources and are never captured into revisions.
export async function prepareNativeSubagentTaskInput(
  input,
  { agentDir, tools, modelSelector, register },
) {
  if (!input || typeof input !== "object")
    throw new Error("OMP_NATIVE_TASK_INVALID");
  const batch = Array.isArray(input.tasks);
  const items = batch ? input.tasks : [input];
  if (!items.length || items.length > 128)
    throw new Error("OMP_NATIVE_TASK_INVALID");
  if (
    input.tools?.length ||
    input.model !== undefined ||
    input.sourceSession !== undefined
  )
    throw new Error("OMP_NATIVE_TASK_OVERRIDE_FORBIDDEN");
  const tasks = await Promise.all(
    items.map(async (item) => {
      if (
        !item ||
        typeof item !== "object" ||
        typeof item.task !== "string" ||
        !item.task.trim()
      )
        throw new Error("OMP_NATIVE_TASK_INVALID");
      if (
        item.tools?.length ||
        item.model !== undefined ||
        item.sourceSession !== undefined ||
        item.taskFile !== undefined
      )
        throw new Error("OMP_NATIVE_TASK_OVERRIDE_FORBIDDEN");
      const role = typeof item.agent === "string" ? item.agent.trim() : "task";
      if (
        !/^[A-Za-z0-9_-]{1,100}$/.test(role) ||
        Buffer.byteLength(item.task) > 128 * 1024
      )
        throw new Error("OMP_NATIVE_TASK_INVALID");
      let imported;
      try {
        imported = JSON.parse(
          await readFile(
            join(agentDir, ".toolplane-roles", `${role}.json`),
            "utf8",
          ),
        );
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const roleTools = imported?.tools
        ? tools.filter((tool) => imported.tools.includes(tool))
        : tools;
      const name = `tp-native-${randomUUID()}`;
      const header = {
        name,
        description: `Temporary task role: ${role}`,
        tools: roleTools.filter((tool) => tool !== "todo"),
        model: imported?.modelSelector ?? modelSelector,
        spawns: "*",
        prewalk: false,
        advisor: false,
      };
      const directory = join(agentDir, "agents");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(
        join(directory, `${name}.md`),
        `---\n${Object.entries(header)
          .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
          .join(
            "\n",
          )}\n---\n${imported?.systemPrompt ?? `You are the temporary ${role} role for this invocation only.`}\nStay within the assignment and inherited authorization. The parent owns the todo list.\n\nAssignment:\n${item.task}\n`,
        { flag: "wx", mode: 0o600 },
      );
      register(name, role, header.model);
      return { ...item, agent: name };
    }),
  );
  return batch ? { ...input, tasks } : { ...input, ...tasks[0] };
}

const code = /(?<!\.d)\.(?:ts|js|mjs|cjs)$/;
const indexes = ["index.ts", "index.js", "index.mjs", "index.cjs"];
function scoped(root, path) {
  if (typeof path !== "string" || path.includes("\\") || path.includes("\0"))
    throw new Error("OMP_PLUGIN_SCOPE");
  const value = resolve(root, path);
  const rel = relative(root, value);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith("../"))
    throw new Error("OMP_PLUGIN_SCOPE");
  return value;
}

// Mirrors OMP 18.14 loader.ts: non-extension directories only name their direct
// index, never every helper module in a dependency closure.
/**
 * @param {{ entries: Array<{path: string, type: string, content?: string}>, resources: Record<string, string[]> }} pkg Immutable package files and declared resource paths.
 * @param {string[] | null} [enabledFeatures=null] Explicit feature names; null selects manifest defaults.
 * @returns {Record<"hooks" | "extensions" | "tools" | "commands", string[]>}
 */
export function resolvePluginEntries(pkg, enabledFeatures = null) {
  const files = new Map(pkg.entries.map((entry) => [entry.path, entry]));
  const metadataEntry = files.get("package/package.json");
  const metadata =
    metadataEntry?.type === "file"
      ? JSON.parse(
          Buffer.from(metadataEntry.content, "base64").toString("utf8"),
        )
      : {};
  const manifest = metadata.omp ?? metadata.pi;
  const result = { hooks: [], extensions: [], tools: [], commands: [] };
  const exists = (path) => files.get(path)?.type === "file";
  const normalize = (path) => {
    const value = posix.normalize(path);
    if (
      !(value === "package" || value.startsWith("package/")) ||
      /[\\\0]/.test(value)
    )
      throw new Error("OMP_PLUGIN_SCOPE");
    return value;
  };
  const declaredEntries = (path) => {
    const item = files.get(`${path}/package.json`);
    if (item?.type !== "file") return undefined;
    const meta = JSON.parse(
      Buffer.from(item.content, "base64").toString("utf8"),
    );
    const entries = (meta.omp ?? meta.pi)?.extensions;
    if (!Array.isArray(entries) || !entries.length) return undefined;
    return entries.map((entry) => {
      if (typeof entry !== "string" || entry.startsWith("/"))
        throw new Error("OMP_PLUGIN_SCOPE");
      const child = normalize(`${path}/${entry}`);
      if (exists(child)) return child;
      const index = indexes.find((name) => exists(`${child}/${name}`));
      if (!index) throw new Error("OMP_PLUGIN_ENTRY_MISSING");
      return `${child}/${index}`;
    });
  };
  function expand(path, extension) {
    path = normalize(path);
    if (exists(path)) return [path];
    const declared = extension ? declaredEntries(path) : undefined;
    if (declared) return declared;
    const index = indexes.find((name) => exists(`${path}/${name}`));
    if (index) return [`${path}/${index}`];
    if (!extension) throw new Error("OMP_PLUGIN_ENTRY_MISSING");
    const children = [
      ...new Set(
        [...files.keys()]
          .filter((name) => name.startsWith(`${path}/`))
          .map((name) => name.slice(path.length + 1).split("/")[0]),
      ),
    ].sort();
    const entries = children.flatMap((name) => {
      const child = `${path}/${name}`;
      if (exists(child)) return code.test(child) ? [child] : [];
      const declared = declaredEntries(child);
      if (declared) return declared;
      const index = indexes.find((name) => exists(`${child}/${name}`));
      return index ? [`${child}/${index}`] : [];
    });
    if (!entries.length) throw new Error("OMP_PLUGIN_ENTRY_MISSING");
    return entries;
  }
  for (const kind of Object.keys(result)) {
    if (manifest) {
      const declared = manifest[kind]
        ? Array.isArray(manifest[kind])
          ? [...manifest[kind]]
          : [manifest[kind]]
        : [];
      for (const [name, feature] of Object.entries(manifest.features ?? {})) {
        if (
          enabledFeatures === null
            ? feature.default === true
            : enabledFeatures.includes(name)
        )
          declared.push(...(feature[kind] ?? []));
      }
      result[kind] = [
        ...new Set(
          declared.flatMap((path) => {
            if (typeof path !== "string" || path.startsWith("/"))
              throw new Error("OMP_PLUGIN_SCOPE");
            return expand(normalize(`package/${path}`), kind === "extensions");
          }),
        ),
      ];
    } else result[kind] = [...new Set(pkg.resources[kind] ?? [])];
    for (const path of result[kind])
      if (!exists(path) || !code.test(path))
        throw new Error("OMP_PLUGIN_ENTRY_INVALID");
  }
  return result;
}

/**
 * @param {{ plugins?: Array<{ marketInstallId: string, releaseId: string, checksum: string, root: string, manifest: import('../src/lib/pi-packages/manifest').PiPackageManifestV1 }>, subagents?: unknown[], nativeRoleModels?: Array<{ marketInstallId: string, releaseId: string, path: string, modelSelector: string }>, agentDir: string }} input
 */
export async function assembleOmpCapabilities({
  plugins = [],
  subagents = [],
  nativeRoleModels = [],
  agentDir,
}) {
  const loaded = [];
  const checksums = new Set();
  const pluginNames = new Set();
  for (const plugin of plugins) {
    if (checksums.has(plugin.checksum)) continue;
    checksums.add(plugin.checksum);
    const pkg = plugin.manifest.package;
    if (pluginNames.has(pkg.name)) throw new Error("OMP_PLUGIN_CONFLICT");
    pluginNames.add(pkg.name);
    const resources = resolvePluginEntries(
      pkg,
      pkg.toolplane?.enabledFeatures ?? null,
    );
    for (const kind of Object.keys(resources))
      resources[kind] = resources[kind].map((path) =>
        scoped(plugin.root, path),
      );
    for (const [index, target] of resources.commands.entries()) {
      const commandDir = join(
        agentDir,
        "commands",
        `pinned-${loaded.length + 1}-${index}`,
      );
      await mkdir(commandDir, { recursive: true, mode: 0o700 });
      await writeFile(
        join(commandDir, "index.ts"),
        `export { default } from ${JSON.stringify(pathToFileURL(target).href)};\n`,
        { flag: "wx", mode: 0o600 },
      );
    }
    loaded.push({
      installId: plugin.marketInstallId,
      name: pkg.name,
      resources,
      config: pkg.toolplane?.config ?? {},
      nativeRoles: [],
    });
    // Package roles stay immutable package resources, never platform Agent records.
    for (const path of pkg.resources.subagents ?? []) {
      const entry = pkg.entries.find(
        (entry) => entry.path === path && entry.type === "file",
      );
      if (!entry) throw new Error("OMP_PLUGIN_ROLE_MISSING");
      const content = Buffer.from(entry.content, "base64").toString("utf8");
      let role;
      if (path.endsWith(".json")) {
        const definition = JSON.parse(content);
        role = {
          name: definition.name ?? posix.basename(path, ".json"),
          systemPrompt: definition.systemPrompt,
          tools: definition.permissions?.builtinTools,
          requiresModel: !!definition.model,
        };
      } else {
        const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
        const field = (name) =>
          new RegExp(`^${name}:\\s*(.+)$`, "m")
            .exec(header?.[1] ?? "")?.[1]
            ?.trim();
        const requiresModel = !!field("model");
        const list = field("tools");
        let allowed;
        if (list) {
          try {
            allowed = JSON.parse(list);
          } catch {
            allowed = list
              .replace(/^\[|\]$/g, "")
              .split(",")
              .map((name) => name.trim().replace(/^['"]|['"]$/g, ""));
          }
        }
        role = {
          name: (field("name") ?? posix.basename(path, ".md")).replace(
            /^['"]|['"]$/g,
            "",
          ),
          systemPrompt: content.slice(header?.[0].length ?? 0),
          tools: allowed,
          requiresModel,
        };
      }
      if (
        !/^[A-Za-z0-9_-]{1,100}$/.test(role.name) ||
        typeof role.systemPrompt !== "string"
      )
        throw new Error("OMP_PLUGIN_ROLE_INVALID");
      const mapped = pkg.toolplane?.nativeRoleModels?.[path];
      const authorized = nativeRoleModels.find(
        (grant) =>
          grant.marketInstallId === plugin.marketInstallId &&
          grant.releaseId === plugin.releaseId &&
          grant.path === path,
      );
      if ((mapped || role.requiresModel) && !authorized)
        throw new Error("OMP_PLUGIN_ROLE_MODEL_UNAUTHORIZED");
      if (authorized) role.modelSelector = authorized.modelSelector;
      loaded.at(-1).nativeRoles.push(role.name);
      const directory = join(agentDir, ".toolplane-roles");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(
        join(directory, `${role.name}.json`),
        JSON.stringify(role),
        { flag: "wx", mode: 0o600 },
      );
    }
    // Non-executable resources are discoverable only from these pinned roots.
    for (const kind of ["skills", "prompts", "themes"]) {
      let index = 0;
      for (const path of pkg.resources[kind] ?? []) {
        const target = scoped(plugin.root, path);
        const destination = join(
          agentDir,
          kind,
          `plugin-${loaded.length}-${++index}${kind === "prompts" ? ".md" : ""}`,
        );
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await symlink(target, destination);
      }
    }
  }
  const names = new Set();
  for (const child of subagents) {
    const name = child.nativeName;
    if (!/^[a-z][a-z0-9_-]{0,99}$/.test(name) || names.has(name))
      throw new Error("OMP_SUBAGENT_INVALID");
    names.add(name);
    const definition = child.definition;
    if (definition.runtimeKind !== "omp")
      throw new Error("OMP_SUBAGENT_RUNTIME_UNSUPPORTED");
    const header = {
      name,
      description: definition.description || child.name,
      tools: child.tools,
      model: child.modelSelector,
      spawns: definition.allowNested
        ? [...subagents.map((item) => item.nativeName)]
        : [],
      prewalk: false,
      advisor: false,
    };
    const path = join(agentDir, "agents", `${name}.md`);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(
      path,
      `---\n${Object.entries(header)
        .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
        .join("\n")}\n---\n${definition.systemPrompt}\n`,
      { flag: "wx", mode: 0o600 },
    );
  }
  return loaded;
}
