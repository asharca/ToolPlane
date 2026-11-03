import { relative, resolve, sep } from "node:path";
const inside = (root, path) =>
  path === root || path.startsWith(`${root}${sep}`);
const executable = /\.(?:[cm]?js|ts)$/;

/** OMP 18.14 manifest/index/one-level discovery over a frozen file inventory. */
export function resolveOmpPluginResources(pkg, files, locked = {}) {
  const name = pkg.manifest.name ?? "plugin";
  const declaration = pkg.manifest.omp ?? pkg.manifest.pi;
  if (!declaration || typeof declaration !== "object")
    throw new Error(`Plugin manifest missing: ${name}`);
  const featureNames =
    locked.enabledFeatures ??
    Object.entries(declaration.features ?? {})
      .filter(([, value]) => value.default === true)
      .map(([key]) => key);
  const selected = [declaration];
  for (const feature of featureNames) {
    if (!Object.hasOwn(declaration.features ?? {}, feature))
      throw new Error(`Unknown plugin feature: ${feature}`);
    selected.push(declaration.features[feature]);
  }
  const byPath = new Map(files.map((file) => [file.path, file]));
  function normalize(base, entry) {
    const absolute = resolve(pkg.path, base, entry);
    if (!inside(pkg.path, absolute))
      throw new Error(`Escaping plugin entry: ${entry}`);
    return relative(pkg.path, absolute).split(sep).join("/");
  }
  const indexes = ["index.ts", "index.js", "index.mjs", "index.cjs"];
  const at = (directory, child) =>
    directory ? `${directory}/${child}` : child;
  const indexOf = (directory) =>
    indexes
      .map((entry) => at(directory, entry))
      .find((path) => byPath.has(path));
  function declaredEntries(directory) {
    const manifest = byPath.get(at(directory, "package.json"));
    if (!manifest) return null;
    const parsed = JSON.parse(manifest.content);
    const declared = (parsed.omp ?? parsed.pi)?.extensions;
    if (!Array.isArray(declared) || !declared.length) return null;
    return declared.map((entry) => {
      if (typeof entry !== "string")
        throw new Error("Invalid extension manifest entry");
      const path = normalize(directory, entry);
      const resolved = byPath.has(path) ? path : indexOf(path);
      if (!resolved) throw new Error(`Missing declared extension: ${path}`);
      return resolved;
    });
  }
  function extensionDirectory(directory) {
    const declared = declaredEntries(directory);
    if (declared) return declared;
    const index = indexOf(directory);
    if (index) return [index];
    const prefix = directory ? `${directory}/` : "";
    const children = [
      ...new Set(
        files
          .filter((file) => file.path.startsWith(prefix))
          .map((file) => file.path.slice(prefix.length).split("/")[0]),
      ),
    ].sort();
    return children.flatMap((child) => {
      const path = at(directory, child);
      if (byPath.has(path))
        return executable.test(child) && !/\.d\.[mc]?ts$/.test(child)
          ? [path]
          : [];
      const declaredChild = declaredEntries(path);
      if (declaredChild) return declaredChild;
      const childIndex = indexOf(path);
      return childIndex ? [childIndex] : [];
    });
  }
  function entries(kind) {
    const result = new Set();
    for (const section of selected) {
      const paths =
        section[kind] === undefined
          ? []
          : Array.isArray(section[kind])
            ? section[kind]
            : [section[kind]];
      for (const entry of paths) {
        if (typeof entry !== "string")
          throw new Error(`Invalid ${kind} entry in ${name}`);
        const normalized = normalize("", entry);
        const directIndex = indexOf(normalized);
        const matches = byPath.has(normalized)
          ? [normalized]
          : kind === "extensions"
            ? extensionDirectory(normalized)
            : directIndex
              ? [directIndex]
              : [];
        if (!matches.length)
          throw new Error(`Missing ${kind} entry: ${name}/${entry}`);
        for (const path of matches) result.add(path);
      }
    }
    return [...result];
  }
  return {
    hooks: entries("hooks"),
    extensions: entries("extensions"),
    tools: entries("tools"),
    commands: entries("commands"),
  };
}
