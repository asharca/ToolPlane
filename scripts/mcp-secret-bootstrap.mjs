// Docker metadata must contain only public launch configuration. The first stdin
// line is consumed by /bin/sh before exec; all subsequent bytes belong to MCP.
export const SECRET_ENV_BOOTSTRAP =
  'IFS= read -r toolplane_env || exit 125; eval "unset toolplane_env; $toolplane_env"; exec "$@"';

export function secretEnvironmentLine(env) {
  return (
    Object.entries(env)
      .map(([key, value]) => {
        if (
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
          typeof value !== "string" ||
          value.includes("\0")
        ) {
          throw new Error("Invalid MCP runtime environment");
        }
        // POSIX printf octal escapes keep newlines, quotes and shell metacharacters
        // inert. A sentinel preserves trailing newlines through command substitution.
        const octal = Array.from(
          Buffer.from(value),
          (byte) => `\\0${byte.toString(8).padStart(3, "0")}`,
        ).join("");
        return `${key}=$(printf '%b_' '${octal}'); ${key}=\${${key}%_}; export ${key};`;
      })
      .join(" ") + "\n"
  );
}

export function withSecretEnvironmentBootstrap(args, image, metadata) {
  const index = args.indexOf(image, 1);
  if (args[0] !== "run" || index < 1)
    throw new Error("Invalid MCP Docker launch");
  const prefix = args.slice(0, index);
  let entrypoint = metadata.Entrypoint ?? [];
  let defaultArgs = metadata.Cmd ?? [];
  if (!Array.isArray(entrypoint) || !Array.isArray(defaultArgs))
    throw new Error("Invalid MCP image command");
  const options = [];
  for (let i = 0; i < prefix.length; i += 1) {
    const arg = prefix[i];
    if (
      arg === "-e" ||
      arg === "--env" ||
      arg === "--env-file" ||
      /^--env(?:-file)?=/.test(arg) ||
      /^-e.+/.test(arg)
    ) {
      throw new Error(
        "Docker environment flags are forbidden for MCP runtime credentials",
      );
    }
    if (arg === "--pull") {
      options.push("--pull", "never");
      i += 1;
    } else if (arg.startsWith("--pull=")) {
      options.push("--pull=never");
    } else if (arg === "--entrypoint") {
      entrypoint = prefix[++i] ? [prefix[i]] : [];
      defaultArgs = [];
    } else if (arg.startsWith("--entrypoint=")) {
      entrypoint = arg.slice(13) ? [arg.slice(13)] : [];
      defaultArgs = [];
    } else {
      options.push(arg);
    }
  }
  const configuredArgs = args.slice(index + 1);
  const command = [
    ...entrypoint,
    ...(configuredArgs.length ? configuredArgs : defaultArgs),
  ];
  if (!command.length || command.some((arg) => typeof arg !== "string"))
    throw new Error("Invalid MCP image command");
  return [
    ...options,
    "--entrypoint",
    "/bin/sh",
    image,
    "-ec",
    SECRET_ENV_BOOTSTRAP,
    "toolplane-mcp",
    ...command,
  ];
}
