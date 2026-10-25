// Shared native namespace policy. This module never imports or executes extension factories.
// Pi 0.87.1 core/slash-commands.js; platform-only reservations are added by the host.
export const PI_RESERVED_COMMANDS = [
  "settings",
  "model",
  "tree",
  "thinking",
  "scoped-models",
  "export",
  "import",
  "share",
  "bug",
  "copy",
  "name",
  "session",
  "changelog",
  "hotkeys",
  "fork",
  "clone",
  "trust",
  "login",
  "logout",
  "new",
  "compact",
  "resume",
  "reload",
  "quit",
];
export const PI_RESERVED_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
];
export class PiCapabilityConflictError extends Error {
  code = "PI_CAPABILITY_CONFLICT";
  constructor() {
    super("PI_CAPABILITY_CONFLICT");
    this.name = "PiCapabilityConflictError";
  }
}
export function assertNativeSkillDiagnostics(diagnostics) {
  if (
    diagnostics.some(
      (item) => item.type === "collision" || item.type === "error",
    )
  )
    throw new PiCapabilityConflictError();
}
export function enforceNativeNamespaces({
  extensions,
  skills,
  prompts,
  toolNames = [],
  hostCommands = [],
}) {
  const commands = new Map(
    [...PI_RESERVED_COMMANDS, ...hostCommands].map((name) => [name, "builtin"]),
  );
  const tools = new Map(
    [...PI_RESERVED_TOOLS, ...toolNames].map((name) => [name, "builtin"]),
  );
  const claim = (map, name, owner) => {
    if (map.has(name) && map.get(name) !== owner)
      throw new PiCapabilityConflictError();
    map.set(name, owner);
  };
  for (const skill of skills) claim(commands, `skill:${skill.name}`, skill);
  for (const prompt of prompts) claim(commands, prompt.name, prompt);
  for (const extension of extensions) {
    for (const name of extension.commands.keys())
      claim(commands, name, extension);
    for (const name of extension.tools.keys()) claim(tools, name, extension);
  }
  // Native registration remains live after factory initialization. Guard the actual
  // Maps used by registerTool/registerCommand, including asynchronous handlers.
  for (const extension of extensions) {
    for (const [map, namespace] of [
      [extension.commands, commands],
      [extension.tools, tools],
    ]) {
      if (map.toolplaneNamespaceGuard) {
        map.toolplaneNamespaceGuard.namespace = namespace;
        continue;
      }
      const set = map.set.bind(map);
      const guard = { namespace };
      Object.defineProperty(map, "toolplaneNamespaceGuard", { value: guard });
      map.set = (name, value) => {
        claim(guard.namespace, name, extension);
        return set(name, value);
      };
    }
  }
  return {
    commands: [...commands.keys()],
    tools: [...tools.keys()],
    skills: skills.map((s) => s.name),
    prompts: prompts.map((p) => ({ name: p.name, path: p.filePath })),
  };
}
