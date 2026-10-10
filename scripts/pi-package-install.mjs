#!/usr/bin/env node
// Standalone, dependency-free installer and stdio MCP transport. Never runs package scripts.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const fail = (code) => {
  throw new Error(code);
};
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const exists = (file) => {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};
function safeAncestors(file) {
  let current = path.resolve(file);
  for (;;) {
    if (exists(current) && fs.lstatSync(current).isSymbolicLink())
      fail("symlink_path_conflict");
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
function atomic(file, bytes, mode = 0o600) {
  safeAncestors(file);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${crypto.randomUUID()}`;
  const fd = fs.openSync(temporary, "wx", mode);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
}
function boundedFile(file, limit = 96 * 1024 * 1024) {
  safeAncestors(file);
  if (!fs.statSync(file).isFile() || fs.statSync(file).size > limit)
    fail("file_limit_exceeded");
  return fs.readFileSync(file);
}
function relative(raw) {
  if (
    typeof raw !== "string" ||
    !raw ||
    raw.length > 2048 ||
    /[^\x20-\uFFFF]|[\\:]/.test(raw) ||
    raw.startsWith("/") ||
    raw.split("/").some((part) => !part || part === "." || part === "..")
  )
    fail("invalid_artifact_path");
  return raw;
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort((a, b) => a.localeCompare(b))
        .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
function configOrigin(cfg) {
  const base = new URL(cfg.baseUrl);
  if (
    (base.protocol !== "https:" &&
      !(
        base.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
      )) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/"
  )
    fail("invalid_origin");
  return base;
}
async function request(cfg, suffix, options = {}, limit = 96 * 1024 * 1024) {
  const url = new URL(
    `/api/v1/pi-packages/installations/${cfg.installationId}/${suffix}`,
    configOrigin(cfg),
  );
  const response = await fetch(url, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(60000),
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${cfg.token}`,
    },
  });
  if (!response.ok && !(suffix === "revoke" && response.status === 404))
    fail(`device_request_failed_${response.status}`);
  if (
    suffix !== "revoke" &&
    (response.status === 202 || response.status === 204)
  )
    return Buffer.alloc(0);
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks = [];
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.length;
      if (bytes > limit) {
        await reader.cancel();
        fail("response_limit_exceeded");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytesResult = Buffer.concat(chunks);
  if (suffix === "revoke") {
    const result = JSON.parse(bytesResult);
    if (
      !(response.ok && result.revoked === true) &&
      !(response.status === 404 && result.error === "pi_installation_not_found")
    )
      fail("device_revocation_failed");
  }
  return bytesResult;
}
async function bridge(cfg) {
  const input = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  let pending = 0;
  for await (const line of input) {
    if (Buffer.byteLength(line) > 256 * 1024 || ++pending > 16)
      fail("mcp_request_limit_exceeded");
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      pending--;
      continue;
    }
    void request(
      cfg,
      "mcp",
      { method: "POST", body: JSON.stringify(message) },
      4_000_000,
    )
      .then((bytes) => {
        if (message.id !== undefined && bytes.length)
          process.stdout.write(`${bytes.toString("utf8")}\n`);
      })
      .catch(() => {
        if (message.id !== undefined)
          process.stdout.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              error: {
                code: -32001,
                message: "ToolPlane device request denied or unavailable",
              },
            })}\n`,
          );
      })
      .finally(() => {
        pending--;
      });
  }
}

export async function installPiPackageClient(command, configFile) {
  const lexicalHome = path.resolve(os.homedir());
  const home = fs.realpathSync(lexicalHome);
  // Canonicalize the explicitly chosen base, not managed descendants. In
  // particular /var -> /private/var on macOS must not relax symlink checks
  // below HOME or any generated package/Skill directory.
  function clientBase(raw) {
    const absolute = path.resolve(raw);
    if (absolute === lexicalHome || absolute.startsWith(lexicalHome + path.sep))
      return path.join(home, path.relative(lexicalHome, absolute));
    if (absolute === home || absolute.startsWith(home + path.sep))
      return absolute;
    const suffix = [];
    let base = absolute;
    while (!exists(base)) {
      suffix.unshift(path.basename(base));
      base = path.dirname(base);
    }
    return path.join(fs.realpathSync(base), ...suffix);
  }
  const configHome = clientBase(
    process.env.XDG_CONFIG_HOME || path.join(home, ".config"),
  );
  configFile = path.join(
    clientBase(path.dirname(path.resolve(configFile))),
    path.basename(configFile),
  );
  const configBytes = boundedFile(configFile, 16384);
  if (process.platform !== "win32" && fs.statSync(configFile).mode & 0o077)
    fail("private_config_required");
  const cfg = JSON.parse(configBytes);
  if (
    !/^[a-zA-Z0-9_-]{1,100}$/.test(cfg.installationId) ||
    !/^tppi_[a-f0-9]{64}$/.test(cfg.token) ||
    !["pi", "claude-code", "codex", "opencode", "hermes"].includes(cfg.client)
  )
    fail("invalid_device_config");
  configOrigin(cfg);
  if (command === "mcp") {
    safeAncestors(
      path.join(configHome, "toolplane", "pi-packages", cfg.installationId),
    );
    return bridge(cfg);
  }
  if (!["install", "update", "uninstall"].includes(command))
    fail("invalid_command");
  const stateRoot = path.join(
    configHome,
    "toolplane",
    "pi-packages",
    cfg.installationId,
  );
  const stateFile = path.join(stateRoot, "state.json");
  const journalFile = path.join(stateRoot, "journal.json");
  const packageRoot = path.join(stateRoot, "package");
  const scriptFile = path.join(stateRoot, "client.mjs");
  const privateConfig = path.join(stateRoot, "config.json");
  const server = `toolplane-pi-${cfg.installationId}`;
  const piHome = clientBase(
    process.env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent"),
  );
  const codexHome = clientBase(
    process.env.CODEX_HOME || path.join(home, ".codex"),
  );
  const opencodeHome = clientBase(
    process.env.OPENCODE_CONFIG_DIR || path.join(configHome, "opencode"),
  );
  const hermesHome = clientBase(
    process.env.HERMES_HOME || path.join(home, ".hermes"),
  );
  const configPaths = {
    pi: path.join(piHome, "settings.json"),
    "claude-code": path.join(home, ".claude.json"),
    codex: path.join(codexHome, "config.toml"),
    opencode:
      process.env.OPENCODE_CONFIG || path.join(opencodeHome, "opencode.json"),
    hermes: process.env.HERMES_CONFIG || path.join(hermesHome, "config.yaml"),
  };
  const skillRoots = {
    "claude-code": path.join(home, ".claude", "skills"),
    codex: path.join(home, ".agents", "skills"),
    opencode: path.join(opencodeHome, "skills"),
    hermes: path.join(hermesHome, "skills"),
  };
  const selectedConfig = configPaths[cfg.client];
  const clientConfig = path.join(
    clientBase(path.dirname(selectedConfig)),
    path.basename(selectedConfig),
  );
  const skillRoot =
    skillRoots[cfg.client] && path.resolve(skillRoots[cfg.client]);
  const allowedPath = (file) =>
    file === clientConfig ||
    file === privateConfig ||
    file === scriptFile ||
    file === stateFile ||
    file === packageRoot ||
    file.startsWith(packageRoot + path.sep) ||
    (skillRoot && file.startsWith(path.join(skillRoot, `${server}-`)));
  function assertManagedPath(file) {
    if (
      !path.isAbsolute(file) ||
      path.normalize(file) !== file ||
      !allowedPath(file)
    )
      fail("invalid_managed_state");
    safeAncestors(path.dirname(file));
  }
  safeAncestors(stateRoot);
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const lock = path.join(stateRoot, "lock");
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const guard = path.join(stateRoot, "recover-lock");
    try {
      fs.mkdirSync(guard);
    } catch {
      fail("installation_busy");
    }
    try {
      const pid = Number(
        boundedFile(path.join(lock, "pid"), 100).toString("utf8"),
      );
      if (!Number.isSafeInteger(pid) || pid <= 0) fail("installation_busy");
      try {
        process.kill(pid, 0);
        fail("installation_busy");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      fs.unlinkSync(path.join(lock, "pid"));
      fs.rmdirSync(lock);
      fs.mkdirSync(lock);
    } finally {
      fs.rmdirSync(guard);
    }
  }
  atomic(path.join(lock, "pid"), String(process.pid));
  function readCurrent(file) {
    assertManagedPath(file);
    if (!exists(file)) return null;
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink())
      return { type: "symlink", target: fs.readlinkSync(file) };
    if (stat.isDirectory()) return { type: "directory" };
    if (!stat.isFile()) fail("managed_file_conflict");
    return {
      type: "file",
      content: boundedFile(file).toString("base64"),
      mode: stat.mode & 0o777,
    };
  }
  function identity(value) {
    return value === null
      ? null
      : value.type === "directory"
        ? "directory"
        : value.type === "symlink"
          ? hash(`link:${value.target}`)
          : hash(Buffer.from(value.content, "base64"));
  }
  function apply(file, value) {
    assertManagedPath(file);
    if (value === null) {
      if (exists(file)) {
        if (fs.lstatSync(file).isDirectory()) fs.rmdirSync(file);
        else fs.unlinkSync(file);
      }
      return;
    }
    if (value.type === "directory") {
      fs.mkdirSync(file, { recursive: true, mode: 0o700 });
      return;
    }
    if (value.type === "symlink") {
      if (exists(file)) fs.unlinkSync(file);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.symlinkSync(value.target, file);
    } else {
      if (exists(file) && fs.lstatSync(file).isSymbolicLink())
        fs.unlinkSync(file);
      atomic(file, Buffer.from(value.content, "base64"), value.mode);
    }
  }
  function recover() {
    if (!exists(journalFile)) return;
    const journal = JSON.parse(boundedFile(journalFile, 192 * 1024 * 1024));
    if (!Array.isArray(journal.changes) || journal.changes.length > 40005)
      fail("invalid_journal");
    const committed =
      exists(stateFile) &&
      JSON.parse(boundedFile(stateFile)).generation === journal.generation;
    if (!committed) {
      for (const item of [...journal.changes].reverse()) {
        const current = identity(readCurrent(item.file));
        if (
          current !== identity(item.before) &&
          current !== identity(item.after)
        )
          fail("recovery_file_conflict");
        if (current !== identity(item.before)) apply(item.file, item.before);
      }
    }
    fs.unlinkSync(journalFile);
  }
  try {
    recover();
    const before = exists(stateFile)
      ? JSON.parse(boundedFile(stateFile))
      : null;
    if (
      before &&
      (before.installationId !== cfg.installationId ||
        before.client !== cfg.client ||
        before.clientConfig !== clientConfig)
    )
      fail("installation_identity_conflict");
    if (before) {
      const saved = JSON.parse(boundedFile(privateConfig, 16384));
      if (
        saved.token !== cfg.token ||
        saved.baseUrl !== cfg.baseUrl ||
        saved.installationId !== cfg.installationId ||
        saved.client !== cfg.client
      )
        fail("installation_credential_conflict");
    }
    if (command === "update" && !before) fail("installation_not_installed");
    if (command === "install" && before) fail("installation_already_exists");
    if (command === "uninstall" && !before) fail("installation_not_installed");
    const nextFiles = new Map();
    let descriptor, artifact;
    if (command !== "uninstall") {
      descriptor = JSON.parse(await request(cfg, "manifest", {}, 65536));
      if (
        descriptor.installationId !== cfg.installationId ||
        descriptor.client !== cfg.client ||
        !/^[a-f0-9]{64}$/.test(descriptor.artifactSha256)
      )
        fail("invalid_client_manifest");
      const bytes = await request(
        cfg,
        `artifact?release=${encodeURIComponent(descriptor.releaseId)}`,
      );
      if (
        bytes.length !== descriptor.artifactBytes ||
        hash(bytes) !== descriptor.artifactSha256
      )
        fail("artifact_checksum_mismatch");
      artifact = JSON.parse(bytes);
      if (
        artifact.schemaVersion !== 1 ||
        artifact.installationId !== cfg.installationId ||
        artifact.client !== cfg.client ||
        artifact.releaseId !== descriptor.releaseId ||
        artifact.releaseChecksum !== descriptor.releaseChecksum
      )
        fail("artifact_identity_mismatch");
      let count = 0,
        total = 0;
      function addEntry(destination, entry) {
        if (++count > 20000 || nextFiles.has(destination))
          fail("artifact_entry_conflict");
        assertManagedPath(destination);
        if (entry.type === "symlink") {
          nextFiles.set(destination, { type: "symlink", target: entry.target });
          return;
        }
        const bytes = Buffer.from(entry.content, "base64");
        total += bytes.length;
        if (
          entry.contentEncoding !== "base64" ||
          bytes.toString("base64") !== entry.content ||
          hash(bytes) !== entry.sha256 ||
          bytes.length > 16 * 1024 * 1024 ||
          total > 64 * 1024 * 1024
        )
          fail("artifact_file_checksum_mismatch");
        nextFiles.set(destination, {
          type: "file",
          content: entry.content,
          mode: entry.executable ? 0o700 : 0o600,
        });
      }
      if (cfg.client === "pi") {
        const manifest = artifact.manifest;
        if (
          manifest?.kind !== "pi-package" ||
          manifest.schemaVersion !== 1 ||
          hash(canonical(manifest)) !== descriptor.releaseChecksum
        )
          fail("release_checksum_mismatch");
        const pkg = manifest.package;
        if (
          pkg.root !== "package" ||
          !Array.isArray(pkg.entries) ||
          pkg.entries.length > 20000 ||
          pkg.runtime.piVersion !== "0.87.1" ||
          pkg.runtime.nodeMajor !== 24
        )
          fail("invalid_pi_snapshot");
        if (
          Number(process.versions.node.split(".")[0]) !== 24 ||
          (pkg.runtime.platform !== "any" &&
            (process.platform !== pkg.runtime.platform ||
              process.arch !== pkg.runtime.arch))
        )
          fail("package_platform_mismatch");
        const entryMap = new Map();
        for (const entry of pkg.entries) {
          relative(entry.path);
          if (entry.path !== "package" && !entry.path.startsWith("package/"))
            fail("invalid_package_path");
          if (
            entryMap.has(entry.path) ||
            !["file", "directory", "symlink"].includes(entry.type)
          )
            fail("artifact_entry_conflict");
          entryMap.set(entry.path, entry);
        }
        function resolveLink(raw, visited = new Set()) {
          if (visited.has(raw)) fail("artifact_link_cycle");
          visited.add(raw);
          const parts = raw.split("/");
          for (let i = 1; i <= parts.length; i++) {
            const prefix = parts.slice(0, i).join("/");
            const entry = entryMap.get(prefix);
            if (entry?.type !== "symlink") continue;
            if (
              typeof entry.target !== "string" ||
              path.posix.isAbsolute(entry.target) ||
              /[^\x20-\uFFFF]|\\/.test(entry.target)
            )
              fail("invalid_artifact_link");
            const target = path.posix.normalize(
              path.posix.join(
                path.posix.dirname(prefix),
                entry.target,
                ...parts.slice(i),
              ),
            );
            if (target !== "package" && !target.startsWith("package/"))
              fail("artifact_link_escape");
            return resolveLink(target, visited);
          }
          return raw;
        }
        for (const entry of entryMap.values()) {
          const parts = entry.path.split("/");
          for (let i = 1; i < parts.length; i++) {
            const parent = entryMap.get(parts.slice(0, i).join("/"));
            if (parent && parent.type !== "directory")
              fail("artifact_parent_conflict");
          }
          if (entry.type === "directory") {
            nextFiles.set(path.join(stateRoot, entry.path), {
              type: "directory",
            });
            continue;
          }
          if (entry.type === "symlink") resolveLink(entry.path);
          addEntry(path.join(stateRoot, entry.path), entry);
        }
      } else {
        if (
          !Array.isArray(artifact.skills) ||
          (!artifact.skills.length && !artifact.mcp)
        )
          fail("pi_package_client_unsupported");
        for (const skill of artifact.skills) {
          if (!/^[a-f0-9]{20}$/.test(skill.key) || !Array.isArray(skill.files))
            fail("invalid_skill_projection");
          for (const file of skill.files) {
            relative(file.path);
            if (file.type !== "file") fail("invalid_skill_projection");
            addEntry(
              path.join(skillRoot, `${server}-${skill.key}`, file.path),
              file,
            );
          }
        }
      }
      for (const file of [...nextFiles.keys()]) {
        for (
          let parent = path.dirname(file);
          parent !== stateRoot && parent !== skillRoot;
          parent = path.dirname(parent)
        ) {
          assertManagedPath(parent);
          if (
            nextFiles.has(parent) &&
            nextFiles.get(parent).type !== "directory"
          )
            fail("artifact_parent_conflict");
          nextFiles.set(parent, { type: "directory" });
        }
      }
      const source = boundedFile(
        fs.realpathSync(fileURLToPath(import.meta.url)),
      );
      nextFiles.set(scriptFile, {
        type: "file",
        content: source.toString("base64"),
        mode: 0o700,
      });
      nextFiles.set(privateConfig, {
        type: "file",
        content: Buffer.from(
          `${JSON.stringify({
            ...cfg,
            ...(cfg.client === "pi" ? { packageRoot } : {}),
          })}\n`,
        ).toString("base64"),
        mode: 0o600,
      });
    }
    const oldFiles = before?.files || {};
    if (cfg.client === "pi" && exists(packageRoot)) {
      const pending = [packageRoot];
      for (const file of pending) {
        if (!oldFiles[file]) fail("unmanaged_package_file");
        if (fs.lstatSync(file).isDirectory())
          pending.push(
            ...fs.readdirSync(file).map((name) => path.join(file, name)),
          );
      }
    }
    const changes = [];
    const nextState = {
      schemaVersion: 1,
      installationId: cfg.installationId,
      client: cfg.client,
      clientConfig,
      generation: crypto.randomUUID(),
      releaseId: descriptor?.releaseId ?? null,
      files: {},
      configValue: null,
    };
    for (const file of new Set([
      ...Object.keys(oldFiles),
      ...nextFiles.keys(),
    ])) {
      const current = readCurrent(file);
      const currentHash = identity(current);
      // The input config is explicitly user supplied; initial canonical placement may already exist.
      const ownInput =
        !before &&
        file === privateConfig &&
        configFile === privateConfig &&
        currentHash === hash(configBytes);
      if (
        current &&
        !ownInput &&
        (!oldFiles[file] || currentHash !== oldFiles[file])
      )
        fail("managed_file_conflict");
      if (!current && oldFiles[file]) fail("managed_file_missing");
      if (
        current?.type === "directory" &&
        fs.readdirSync(file).some((name) => !oldFiles[path.join(file, name)])
      )
        fail("unmanaged_directory_contents");
      const after = nextFiles.get(file) ?? null;
      if (after) nextState.files[file] = identity(after);
      if (JSON.stringify(current) !== JSON.stringify(after))
        changes.push({ file, before: current, after });
    }
    const configCurrent = readCurrent(clientConfig);
    if (configCurrent && configCurrent.type !== "file")
      fail("client_config_conflict");
    const configText = configCurrent
      ? Buffer.from(configCurrent.content, "base64").toString("utf8")
      : "";
    const enable =
      command !== "uninstall" && (cfg.client === "pi" || artifact.mcp);
    const args = [scriptFile, "mcp", "--config", privateConfig];
    let configAfter;
    if (["pi", "claude-code", "opencode"].includes(cfg.client)) {
      let object;
      try {
        object = configText.trim() ? JSON.parse(configText) : {};
      } catch {
        fail("client_config_not_json");
      }
      if (!object || typeof object !== "object" || Array.isArray(object))
        fail("client_config_invalid");
      if (cfg.client === "pi") {
        if (object.packages !== undefined && !Array.isArray(object.packages))
          fail("client_config_invalid");
        const packages = object.packages || [];
        const matching = packages.filter(
          (item) =>
            item === packageRoot ||
            (item && typeof item === "object" && item.source === packageRoot),
        );
        if (
          matching.length > 1 ||
          (matching.length && (!before || matching[0] !== packageRoot)) ||
          (before && !matching.length)
        )
          fail("client_config_conflict");
        object.packages = packages.filter((item) => item !== packageRoot);
        if (enable) object.packages.push(packageRoot);
        nextState.configValue = enable ? packageRoot : null;
      } else {
        const key = cfg.client === "opencode" ? "mcp" : "mcpServers";
        if (
          object[key] !== undefined &&
          (!object[key] ||
            typeof object[key] !== "object" ||
            Array.isArray(object[key]))
        )
          fail("client_config_invalid");
        object[key] ||= {};
        const current = object[key][server] ?? null;
        if (
          JSON.stringify(current) !==
          JSON.stringify(before?.configValue ?? null)
        )
          fail("client_config_conflict");
        const value =
          cfg.client === "opencode"
            ? { type: "local", command: ["node", ...args], enabled: true }
            : { command: "node", args };
        if (enable) object[key][server] = value;
        else delete object[key][server];
        nextState.configValue = enable ? value : null;
      }
      configAfter = `${JSON.stringify(object, null, 2)}\n`;
    } else {
      const begin = `# BEGIN TOOLPLANE PI ${cfg.installationId}`,
        end = `# END TOOLPLANE PI ${cfg.installationId}`;
      const lines = configText.split(/\r?\n/);
      const starts = [],
        ends = [];
      lines.forEach((line, i) => {
        if (line.trim() === begin) starts.push(i);
        if (line.trim() === end) ends.push(i);
      });
      if (
        starts.length !== ends.length ||
        starts.length > 1 ||
        (starts.length && ends[0] <= starts[0])
      )
        fail("client_config_markers_invalid");
      const existing = starts.length
        ? lines.slice(starts[0], ends[0] + 1).join("\n")
        : null;
      if (existing !== (before?.configValue ?? null))
        fail("client_config_conflict");
      if (starts.length) lines.splice(starts[0], ends[0] - starts[0] + 1);
      let block = null;
      if (enable && cfg.client === "codex") {
        if (lines.some((line) => line.includes(server)))
          fail("client_config_conflict");
        block = [
          begin,
          `[mcp_servers.${server}]`,
          'command = "node"',
          `args = ${JSON.stringify(args)}`,
          end,
        ].join("\n");
        lines.push("", block);
      } else if (enable) {
        if (lines.some((line) => line.includes(server)))
          fail("client_config_conflict");
        const keys = lines.filter((line) => /^mcp_servers:/.test(line));
        if (
          keys.length > 1 ||
          keys.some(
            (line) => !/^mcp_servers:\s*(?:\{\}\s*)?(?:#.*)?$/.test(line),
          )
        )
          fail("hermes_config_mapping_unsupported");
        let index = lines.findIndex((line) => /^mcp_servers:/.test(line));
        if (index < 0) {
          lines.push("mcp_servers:");
          index = lines.length - 1;
        } else lines[index] = "mcp_servers:";
        block = [
          `  ${begin}`,
          `  ${server}:`,
          '    command: "node"',
          `    args: ${JSON.stringify(args)}`,
          `  ${end}`,
        ].join("\n");
        lines.splice(index + 1, 0, block);
      }
      nextState.configValue = block;
      configAfter = lines.join("\n");
    }
    const configValue = {
      type: "file",
      content: Buffer.from(configAfter).toString("base64"),
      mode: configCurrent?.mode ?? 0o600,
    };
    if (configAfter !== configText)
      changes.push({
        file: clientConfig,
        before: configCurrent,
        after: configValue,
      });
    changes.sort((a, b) =>
      a.after === null && b.after !== null
        ? -1
        : b.after === null && a.after !== null
          ? 1
          : a.after === null
            ? b.file.length - a.file.length
            : a.file.length - b.file.length,
    );
    if (command === "uninstall")
      await request(cfg, "revoke", { method: "DELETE" }, 16384);
    const priorState = readCurrent(stateFile);
    const stateValue = {
      type: "file",
      content: Buffer.from(`${JSON.stringify(nextState)}\n`).toString("base64"),
      mode: 0o600,
    };
    changes.push({ file: stateFile, before: priorState, after: stateValue });
    atomic(
      journalFile,
      JSON.stringify({ generation: nextState.generation, changes }),
    );
    for (const item of changes) {
      if (identity(readCurrent(item.file)) !== identity(item.before))
        fail("concurrent_file_change");
      apply(item.file, item.after);
    }
    recover();
    if (command === "uninstall") {
      fs.unlinkSync(stateFile);
      console.log("Uninstalled managed files and revoked this device.");
    } else {
      for (const warning of artifact.warnings || [])
        console.warn(
          "Warning: " +
            warning +
            " (only Skills/MCP installed for this client).",
        );
      console.log(
        "Installed approved release " +
          descriptor.releaseId +
          ". Restart " +
          cfg.client +
          ".",
      );
    }
  } catch (error) {
    try {
      recover();
    } catch {
      /* Preserve journal for explicit recovery; never overwrite a conflicting user file. */
    }
    throw error;
  } finally {
    fs.unlinkSync(path.join(lock, "pid"));
    fs.rmdirSync(lock);
  }
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) ===
    fs.realpathSync(fileURLToPath(import.meta.url))
) {
  const [command, flag, config] = process.argv.slice(2);
  if (flag !== "--config" || !config || process.argv.length !== 5) {
    console.error(
      "Usage: node pi-package-install.mjs install|update|uninstall|mcp --config <private-config.json>",
    );
    process.exitCode = 1;
  } else
    installPiPackageClient(command, config).catch((error) => {
      console.error(
        "ToolPlane Pi client: " +
          (/^[a-z0-9_]+$/.test(error.message)
            ? error.message
            : "installation_failed"),
      );
      process.exitCode = 1;
    });
}
