#!/usr/bin/env node
/** Trusted capture host: stdout is exclusively bounded broker NDJSON. */
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  lstat,
  readlink,
  realpath,
  cp,
  rm,
} from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sdkEntry = await realpath(
  "/opt/pi-sdk/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
);
const require = createRequire(sdkEntry);
const semver = require("semver");
const { ProxyAgent, fetch } = require("undici");
const sdkRoot = dirname(sdkEntry);
const { parseGitUrl } = await import(
  pathToFileURL(join(sdkRoot, "utils/git.js"))
);
const { DefaultPackageManager } = await import(
  pathToFileURL(join(sdkRoot, "core/package-manager.js"))
);
const { SettingsManager } = await import(
  pathToFileURL(join(sdkRoot, "core/settings-manager.js"))
);
const ROOT = "/tmp/snapshot";
const PACKAGE = `${ROOT}/package`;
const HELPER = "/app/scripts/pi-package-archive.py";
const FRAME = 65536;
const MAX_JSON = 96 * 1024 * 1024;
const channels = new Map();
const closedChannels = new Map();
const clients = new Set();
let networkBytes = 0;
let outputChain = Promise.resolve();
let stopping = false;
let configuration;
let acceptConfiguration;
const configured = new Promise((resolve) => {
  acceptConfiguration = resolve;
});
function fail() {
  stopping = true;
  for (const client of clients) client.destroy();
  process.exit(1);
}
function send(frame) {
  outputChain = outputChain.then(async () => {
    const line = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(line) > 96 * 1024) throw Error("frame_limit");
    if (!process.stdout.write(line)) await once(process.stdout, "drain");
  });
  outputChain.catch(fail);
  return outputChain;
}
function count(channel, size) {
  channel.bytes += size;
  networkBytes += size;
  if (channel.bytes > 128 * 1024 * 1024 || networkBytes > 256 * 1024 * 1024)
    throw Error("network_limit");
}
function decode(data) {
  if (
    typeof data !== "string" ||
    data.length > 87384 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      data,
    )
  )
    throw Error("frame_invalid");
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length || bytes.length > FRAME) throw Error("frame_invalid");
  return bytes;
}
async function incoming(message) {
  if (
    message?.type === "configuration" &&
    !configuration &&
    Object.keys(message).sort().join(",") === "authentication,registry,type"
  ) {
    publicUrl(message.registry);
    if (message.authentication) {
      publicUrl(message.authentication.url);
      if (
        !/^(Bearer|Basic) [\x21-\x7e]{1,8192}$/.test(
          message.authentication.authorization,
        )
      )
        throw Error("configuration_invalid");
    }
    configuration = message;
    acceptConfiguration();
    return;
  }
  if (!message || typeof message !== "object" || typeof message.id !== "string")
    throw Error("frame_invalid");
  const channel = channels.get(message.id) || closedChannels.get(message.id);
  if (!channel) throw Error("frame_unknown");
  const keys = Object.keys(message).sort().join(",");
  if (channel.closed) {
    if (message.type === "data" && keys === "data,id,type")
      count(channel, decode(message.data).length);
    else if (!(message.type === "close" && keys === "id,type"))
      throw Error("frame_invalid");
    return;
  }
  if (message.type === "connected" && keys === "id,type" && channel.pending) {
    channel.pending = false;
    clearTimeout(channel.timer);
    channel.accept();
  } else if (
    message.type === "data" &&
    keys === "data,id,type" &&
    !channel.pending
  ) {
    const data = decode(message.data);
    count(channel, data.length);
    if (!channel.socket.destroyed && !channel.socket.write(data))
      await once(channel.socket, "drain");
  } else if (message.type === "close" && keys === "id,type") {
    clearTimeout(channel.timer);
    channel.reject?.(Error("connect_closed"));
    channel.closed = true;
    channel.socket.destroy();
    channels.delete(message.id);
    closedChannels.set(message.id, channel);
  } else if (
    message.type === "error" &&
    keys === "code,id,type" &&
    typeof message.code === "string"
  ) {
    throw Error("broker_rejected");
  } else throw Error("frame_invalid");
}
let inputBuffer = Buffer.alloc(0);
let inputChain = Promise.resolve();
process.stdin.on("data", (chunk) => {
  process.stdin.pause();
  inputChain = inputChain.then(async () => {
    inputBuffer = Buffer.concat([inputBuffer, chunk]);
    for (;;) {
      const end = inputBuffer.indexOf(10);
      if (end < 0) break;
      if (end > 96 * 1024) throw Error("frame_limit");
      const line = inputBuffer.subarray(0, end);
      inputBuffer = inputBuffer.subarray(end + 1);
      await incoming(JSON.parse(line.toString("utf8")));
    }
    if (inputBuffer.length > 96 * 1024) throw Error("frame_limit");
    process.stdin.resume();
  });
  inputChain.catch(fail);
});
process.stdin.on("end", () => {
  if (!stopping) fail();
});
process.stdin.on("error", fail);
process.stdout.on("error", fail);

const proxy = createServer((socket) => {
  clients.add(socket);
  socket.on("error", () => socket.destroy());
  socket.once("close", () => clients.delete(socket));
  let header = Buffer.alloc(0);
  const receiveHeader = (chunk) => {
    header = Buffer.concat([header, chunk]);
    if (header.length > 16384) return fail();
    const end = header.indexOf("\r\n\r\n");
    if (end < 0) return;
    socket.pause();
    socket.removeListener("data", receiveHeader);
    const match = /^CONNECT ([a-zA-Z0-9.-]+):443 HTTP\/1\.[01]\r\n/.exec(
      header.subarray(0, end + 2).toString("ascii"),
    );
    if (
      !match ||
      channels.size >= 16 ||
      channels.size + closedChannels.size >= 20000
    )
      return fail();
    const id = randomUUID();
    const channel = { socket, bytes: 0, pending: true, closed: false };
    channels.set(id, channel);
    const connected = new Promise((accept, reject) => {
      channel.accept = accept;
      channel.reject = reject;
    });
    channel.timer = setTimeout(fail, 15000);
    socket.once("close", () => {
      clearTimeout(channel.timer);
      if (!channel.closed) {
        channel.closed = true;
        channels.delete(id);
        closedChannels.set(id, channel);
        send({ type: "close", id });
      }
    });
    const forward = async (data) => {
      count(channel, data.length);
      for (let offset = 0; offset < data.length; offset += FRAME)
        await send({
          type: "data",
          id,
          data: data.subarray(offset, offset + FRAME).toString("base64"),
        });
    };
    send({ type: "connect", id, host: match[1], port: 443 });
    connected
      .then(async () => {
        socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
        const leftover = header.subarray(end + 4);
        if (leftover.length) await forward(leftover);
        let chain = Promise.resolve();
        socket.on("data", (data) => {
          socket.pause();
          chain = chain.then(() => forward(data)).then(() => socket.resume());
          chain.catch(fail);
        });
        socket.resume();
      })
      .catch(fail);
  };
  socket.on("data", receiveHeader);
});
await new Promise((resolve) => proxy.listen(3128, "127.0.0.1", resolve));
const proxyUrl = "http://127.0.0.1:3128";
const dispatcher = new ProxyAgent(proxyUrl);
const env = {
  PATH: process.env.PATH,
  HOME: "/tmp/home",
  TMPDIR: "/tmp",
  LANG: "C.UTF-8",
  HTTPS_PROXY: proxyUrl,
  HTTP_PROXY: proxyUrl,
  ALL_PROXY: proxyUrl,
  https_proxy: proxyUrl,
  http_proxy: proxyUrl,
  all_proxy: proxyUrl,
  npm_config_https_proxy: proxyUrl,
  npm_config_proxy: proxyUrl,
  npm_config_registry: "https://registry.npmjs.org/",
  npm_config_userconfig: "/dev/null",
  npm_config_globalconfig: "/dev/null",
  COREPACK_ENABLE_PROJECT_SPEC: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  COREPACK_HOME: "/opt/corepack",
  COREPACK_DEFAULT_TO_LATEST: "0",
  COREPACK_ENABLE_NETWORK: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "6",
  GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_VALUE_0: "/dev/null",
  GIT_CONFIG_KEY_1: "credential.helper",
  GIT_CONFIG_VALUE_1: "",
  GIT_CONFIG_KEY_2: "submodule.recurse",
  GIT_CONFIG_VALUE_2: "false",
  GIT_CONFIG_KEY_3: "http.proxy",
  GIT_CONFIG_VALUE_3: proxyUrl,
  GIT_CONFIG_KEY_4: "protocol.allow",
  GIT_CONFIG_VALUE_4: "never",
  GIT_CONFIG_KEY_5: "protocol.https.allow",
  GIT_CONFIG_VALUE_5: "always",
  ...(process.env.NODE_EXTRA_CA_CERTS
    ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS }
    : {}),
  ...(process.env.GIT_SSL_CAINFO
    ? { GIT_SSL_CAINFO: process.env.GIT_SSL_CAINFO }
    : {}),
};
await mkdir(env.HOME, { recursive: true });
function publicUrl(raw) {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    (url.port && url.port !== "443")
  )
    throw Error("source_invalid");
  const path = decodeURIComponent(url.pathname);
  if (
    /[^\x21-\uFFFF]|[\\\x7f%]/.test(path) ||
    path.split("/").some((part) => part === "." || part === "..")
  )
    throw Error("source_invalid");
  return url;
}
function authorizationFor(url) {
  const authentication = configuration.authentication;
  if (!authentication) return undefined;
  const scope = publicUrl(authentication.url);
  const prefix = decodeURIComponent(scope.pathname).replace(/\/$/, "");
  const path = decodeURIComponent(url.pathname);
  return url.origin === scope.origin &&
    (path === prefix || path.startsWith(`${prefix}/`))
    ? authentication.authorization
    : undefined;
}
function parseSource(raw) {
  if (
    typeof raw !== "string" ||
    raw.length > 2048 ||
    /[^\x20-\uFFFF]|[\x7f\\]/.test(raw)
  )
    throw Error("source_invalid");
  if (raw.startsWith("npm:")) {
    const match = /^npm:((?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+)(?:@(.+))?$/.exec(
      raw,
    );
    if (
      !match ||
      (match[2] &&
        !semver.validRange(match[2]) &&
        !/^[a-zA-Z0-9_.-]+$/.test(match[2]))
    )
      throw Error("source_invalid");
    return {
      kind: "npm",
      requested: raw,
      name: match[1],
      range: match[2] || "latest",
    };
  }
  if (/\s/.test(raw)) throw Error("source_invalid");
  let candidate = raw;
  const fragmentIndex = candidate.indexOf("#");
  const fragmentRef =
    fragmentIndex < 0
      ? undefined
      : decodeURIComponent(candidate.slice(fragmentIndex + 1));
  if (fragmentIndex >= 0) candidate = candidate.slice(0, fragmentIndex);
  if (candidate.startsWith("git@")) candidate = `git:${candidate}`;
  const parsed = parseGitUrl(candidate);
  if (!parsed) throw Error("source_invalid");
  let repo = parsed.repo;
  if (repo.startsWith("git@"))
    repo = repo.replace(/^git@([^:]+):/, "https://$1/");
  const url = publicUrl(repo);
  url.hash = "";
  const ref = fragmentRef || parsed.ref || "HEAD";
  if (/^[-]|[^\x21-\uFFFF]|[\x7f\\]|\.\./.test(ref))
    throw Error("source_invalid");
  return { kind: "git", requested: raw, url: url.toString(), ref };
}
async function run(command, args, cwd, maxOutput = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    let count = 0;
    let diagnostics = 0;
    child.stdout.on("data", (chunk) => {
      count += chunk.length;
      if (count > maxOutput) {
        child.kill("SIGKILL");
        reject(Error("process_output_limit"));
      } else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      diagnostics += chunk.length;
      if (command === "python3") {
        const reason = chunk
          .toString("utf8")
          .match(/^package_archive_invalid:([a-z_]{1,40})\n$/)?.[1];
        if (reason)
          process.stderr.write(`Package archive rejected: ${reason}.\n`);
      }
      if (diagnostics > 1024 * 1024) {
        child.kill("SIGKILL");
        reject(Error("process_output_limit"));
      }
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(Error("package_capture_failed")),
    );
  });
}
async function download(raw, maxBytes) {
  let url = publicUrl(raw);
  for (let redirects = 0; redirects <= 10; redirects++) {
    const authorization = authorizationFor(url);
    const response = await fetch(url, {
      dispatcher,
      redirect: "manual",
      headers: authorization ? { authorization } : {},
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      if (authorization) throw Error("authenticated_redirect_blocked");
      url = publicUrl(
        new URL(response.headers.get("location"), url).toString(),
      );
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw Error("download_failed");
    }
    const chunks = [];
    let count = 0;
    for await (const chunk of response.body) {
      count += chunk.length;
      if (count > maxBytes) {
        await response.body.cancel().catch(() => {});
        throw Error("download_limit");
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw Error("redirect_limit");
}
function verifyIntegrity(data, integrity) {
  if (typeof integrity !== "string") throw Error("integrity_missing");
  const candidates = integrity
    .split(/\s+/)
    .map((item) =>
      /^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/]+={0,2})$/.exec(item),
    )
    .filter(Boolean);
  const strongest = ["sha512", "sha384", "sha256", "sha1"].find((algorithm) =>
    candidates.some((item) => item[1] === algorithm),
  );
  if (
    !strongest ||
    !candidates.some(
      (item) =>
        item[1] === strongest &&
        createHash(strongest).update(data).digest("base64") === item[2],
    )
  )
    throw Error("integrity_invalid");
}
async function capture(source) {
  await mkdir(ROOT, { recursive: true });
  if (source.kind === "npm") {
    const metadata = JSON.parse(
      (
        await download(
          new URL(encodeURIComponent(source.name), configuration.registry).href,
          2 * 1024 * 1024,
        )
      ).toString("utf8"),
    );
    const version =
      semver.valid(source.range) ||
      metadata["dist-tags"]?.[source.range] ||
      semver.maxSatisfying(Object.keys(metadata.versions || {}), source.range);
    const selected = metadata.versions?.[version];
    if (
      !selected ||
      selected.name !== source.name ||
      selected.version !== version ||
      !semver.valid(version)
    )
      throw Error("npm_version_missing");
    const bytes = await download(selected.dist.tarball, 64 * 1024 * 1024);
    verifyIntegrity(bytes, selected.dist.integrity);
    await writeFile("/tmp/source.tgz", bytes);
    await run("python3", [
      HELPER,
      "extract",
      "/tmp/source.tgz",
      PACKAGE,
      "npm",
    ]);
    return {
      kind: "npm",
      requested: source.requested,
      name: selected.name,
      version,
      integrity: selected.dist.integrity,
      ...(configuration.registry === "https://registry.npmjs.org/"
        ? {}
        : { registry: configuration.registry }),
    };
  }
  await mkdir("/tmp/repo");
  if (configuration.authentication) {
    if (!authorizationFor(publicUrl(source.url)))
      throw Error("credential_scope_invalid");
    await writeFile(
      "/tmp/git-auth",
      `[http ${JSON.stringify(source.url)}]\n\textraHeader = ${JSON.stringify(`Authorization: ${configuration.authentication.authorization}`)}\n[http]\n\tfollowRedirects = false\n`,
      { mode: 0o600 },
    );
    env.GIT_CONFIG_GLOBAL = "/tmp/git-auth";
  }
  await run("git", ["init", "/tmp/repo"]);
  await run(
    "git",
    [
      "fetch",
      "--no-recurse-submodules",
      "--depth=1",
      "--",
      source.url,
      source.ref,
    ],
    "/tmp/repo",
  );
  const commit = (
    await run(
      "git",
      ["rev-parse", "--verify", "FETCH_HEAD^{commit}"],
      "/tmp/repo",
    )
  )
    .toString("utf8")
    .trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw Error("git_commit_invalid");
  await run(
    "git",
    ["archive", "--format=tar", "-o", "/tmp/source.tar", commit],
    "/tmp/repo",
  );
  await run("python3", [HELPER, "extract", "/tmp/source.tar", PACKAGE, "git"]);
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  await rm("/tmp/git-auth", { force: true });
  return { kind: "git", requested: source.requested, url: source.url, commit };
}
function inside(root, path) {
  return path === root || path.startsWith(`${root}/`);
}
async function checkDependencies(manifest, base) {
  for (const dependencies of [
    manifest.dependencies,
    manifest.optionalDependencies,
  ]) {
    if (dependencies === undefined) continue;
    if (
      !dependencies ||
      typeof dependencies !== "object" ||
      Array.isArray(dependencies)
    )
      throw Error("dependencies_invalid");
    for (const [name, spec] of Object.entries(dependencies)) {
      if (
        !/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(name) ||
        typeof spec !== "string"
      )
        throw Error("dependencies_invalid");
      if (/^(workspace:|link:|portal:)|^\//.test(spec))
        throw Error("dependency_path_invalid");
      if (
        spec.startsWith("file:") ||
        spec.startsWith("./") ||
        spec.startsWith("../")
      ) {
        const target = await realpath(
          resolve(base, spec.replace(/^file:/, "")),
        );
        if (!inside(PACKAGE, target)) throw Error("dependency_path_invalid");
      } else if (/^(?:git\+)?https?:|^git:|^ssh:|^git@/.test(spec)) {
        const raw = spec.replace(/^git\+/, "");
        if (raw.startsWith("https:")) publicUrl(raw);
        else throw Error("dependency_source_invalid");
      }
    }
  }
}
async function merge(source, target) {
  const sourceStat = await lstat(source);
  if (sourceStat.isFile() && sourceStat.size > 16 * 1024 * 1024)
    throw Error("file_limit");
  const targetStat = await lstat(target).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (!targetStat) {
    await cp(source, target, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    });
    return;
  }
  if (sourceStat.isDirectory() && targetStat.isDirectory()) {
    for (const name of await readdir(source))
      await merge(join(source, name), join(target, name));
  } else if (sourceStat.isSymbolicLink() && targetStat.isSymbolicLink()) {
    if ((await readlink(source)) !== (await readlink(target)))
      throw Error("bundled_conflict");
  } else if (sourceStat.isFile() && targetStat.isFile()) {
    if (
      !(await readFile(source)).equals(await readFile(target)) ||
      Boolean(sourceStat.mode & 0o111) !== Boolean(targetStat.mode & 0o111)
    )
      throw Error("bundled_conflict");
  } else throw Error("bundled_conflict");
}
// Credentials stay in this trusted process. pnpm receives only loopback, token-free URLs.
// Every tarball is mapped from bounded registry metadata; neither redirects nor a dependency URL can choose a credential target.
const tarballs = new Map();
let registryServer;
async function startRegistry() {
  registryServer = createHttpServer(async (request, response) => {
    try {
      if (request.method !== "GET" || !request.url || request.url.length > 2048)
        throw Error("registry_request_invalid");
      const local = new URL(request.url, "http://127.0.0.1:3129");
      if (local.origin !== "http://127.0.0.1:3129" || local.search)
        throw Error("registry_request_invalid");
      const tarball = tarballs.get(local.pathname);
      if (tarball) {
        response.setHeader("content-type", "application/octet-stream");
        response.end(await download(tarball, 64 * 1024 * 1024));
        return;
      }
      const packageName = decodeURIComponent(local.pathname.slice(1));
      if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(packageName))
        throw Error("registry_request_invalid");
      const metadata = JSON.parse(
        (
          await download(
            new URL(encodeURIComponent(packageName), configuration.registry)
              .href,
            2 * 1024 * 1024,
          )
        ).toString("utf8"),
      );
      if (
        metadata.name !== packageName ||
        !metadata.versions ||
        typeof metadata.versions !== "object"
      )
        throw Error("registry_metadata_invalid");
      for (const version of Object.values(metadata.versions)) {
        if (!version?.dist?.tarball) continue;
        const target = publicUrl(version.dist.tarball).href;
        if (tarballs.size >= 20000) throw Error("registry_limit");
        const key = `/_tarballs/${randomUUID()}`;
        tarballs.set(key, target);
        version.dist.tarball = `http://127.0.0.1:3129${key}`;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(metadata));
    } catch {
      response.statusCode = 502;
      response.end("package_capture_failed");
    }
  });
  await new Promise((resolve) =>
    registryServer.listen(3129, "127.0.0.1", resolve),
  );
  env.npm_config_registry = "http://127.0.0.1:3129/";
  env.NO_PROXY = env.no_proxy = "127.0.0.1,localhost";
}
async function installDependencies() {
  const original = await readFile(`${PACKAGE}/package.json`).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return Buffer.from("{}");
  });
  const manifest = JSON.parse(original.toString("utf8"));
  await checkDependencies(manifest, PACKAGE);
  const declared =
    manifest.bundledDependencies ?? manifest.bundleDependencies ?? [];
  const bundled =
    declared === true
      ? Object.keys(manifest.dependencies || {})
      : declared === false
        ? []
        : declared;
  if (
    !Array.isArray(bundled) ||
    bundled.some(
      (name) =>
        typeof name !== "string" ||
        !/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(name),
    )
  )
    throw Error("bundled_invalid");
  // Install in a clean sibling tree: package configs and original lockfiles never reach pnpm.
  await cp(PACKAGE, "/tmp/install", {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  for (const name of [
    "node_modules",
    ".npmrc",
    ".pnpmfile.cjs",
    "pnpmfile.cjs",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
  ])
    await rm(`/tmp/install/${name}`, { recursive: true, force: true });
  const stripped = {};
  for (const key of ["name", "version"])
    if (manifest[key] !== undefined) stripped[key] = manifest[key];
  for (const key of ["dependencies", "optionalDependencies"])
    if (manifest[key])
      stripped[key] = Object.fromEntries(
        Object.entries(manifest[key]).filter(
          ([name]) => !bundled.includes(name),
        ),
      );
  stripped.bundledDependencies = bundled;
  await rm("/tmp/install/package.json", { force: true });
  await writeFile("/tmp/install/package.json", JSON.stringify(stripped));
  // Validate local dependency manifests without changing their original runtime bytes.
  async function sanitize(directory) {
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) continue;
      if (
        [
          ".npmrc",
          ".pnpmfile.cjs",
          "pnpmfile.cjs",
          "pnpm-workspace.yaml",
        ].includes(name)
      )
        await rm(path, { recursive: true, force: true });
      else if (info.isDirectory()) await sanitize(path);
      else if (
        name === "package.json" &&
        path !== "/tmp/install/package.json"
      ) {
        const value = JSON.parse((await readFile(path)).toString("utf8"));
        await checkDependencies(
          value,
          join(PACKAGE, relative("/tmp/install", directory)),
        );
      }
    }
  }
  await sanitize("/tmp/install");
  await run(
    "pnpm",
    [
      "install",
      "--prod",
      "--ignore-scripts",
      "--ignore-pnpmfile",
      "--ignore-workspace",
      "--no-frozen-lockfile",
      "--config.auto-install-peers=false",
      "--config.strict-peer-dependencies=false",
      "--config.manage-package-manager-versions=false",
      "--config.node-linker=hoisted",
      "--package-import-method=copy",
      "--store-dir=/tmp/pnpm-store",
      "--network-concurrency=8",
    ],
    "/tmp/install",
  );
  if (await lstat("/tmp/install/node_modules").catch(() => null)) {
    for (const path of [
      ".modules.yaml",
      ".pnpm/lock.yaml",
      ".pnpm-workspace-state-v1.json",
    ])
      await rm(`/tmp/install/node_modules/${path}`, { force: true });
    await merge("/tmp/install/node_modules", `${PACKAGE}/node_modules`);
  }
  for (const name of bundled) {
    if (!(await lstat(`${PACKAGE}/node_modules/${name}`).catch(() => null)))
      throw Error("bundled_missing");
  }
  return manifest;
}
async function resources() {
  const manager = new DefaultPackageManager({
    cwd: PACKAGE,
    agentDir: "/tmp/pi-agent",
    settingsManager: SettingsManager.inMemory(),
  });
  const resolved = await manager.resolveExtensionSources([PACKAGE], {
    temporary: true,
  });
  async function fallbackEntries(directory, scanChildren) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const name of ["index.ts", "index.js"]) {
      if (entries.some((entry) => entry.name === name && !entry.isDirectory()))
        return [join(directory, name)];
    }
    if (!scanChildren) return [];
    const paths = [];
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (
        (entry.isFile() || entry.isSymbolicLink()) &&
        /\.(?:js|ts)$/.test(entry.name)
      )
        paths.push(path);
      else if (
        entry.isDirectory() ||
        (entry.isSymbolicLink() &&
          (await lstat(await realpath(path))).isDirectory())
      ) {
        const nested = await manager.resolveExtensionSources([path], {
          temporary: true,
        });
        const declared = nested.extensions.filter(
          (resource) => resource.enabled && resolve(resource.path) !== path,
        );
        if (declared.length)
          paths.push(...declared.map((resource) => resource.path));
        else paths.push(...(await fallbackEntries(path, false)));
      }
    }
    return paths;
  }
  const extensionPaths = [];
  for (const resource of resolved.extensions) {
    if (!resource.enabled) continue;
    if (resolve(resource.path) === PACKAGE)
      extensionPaths.push(...(await fallbackEntries(PACKAGE, true)));
    else extensionPaths.push(resource.path);
  }
  resolved.extensions = [...new Set(extensionPaths)].map((path) => ({
    path,
    enabled: true,
  }));
  const result = {};
  for (const kind of ["extensions", "skills", "prompts", "themes"]) {
    result[kind] = [];
    for (const resource of resolved[kind]) {
      if (!resource.enabled) continue;
      const path = await realpath(resource.path);
      if (!inside(PACKAGE, path) || !inside(PACKAGE, resolve(resource.path)))
        throw Error("resource_escape");
      // Resource resolution is metadata-only; no extension factory is imported.
      result[kind].push(relative(ROOT, resource.path));
    }
  }
  if (!Object.values(result).some((paths) => paths.length))
    throw Error("pi_resources_missing");
  return result;
}
let captureStage = "source";
async function main() {
  await configured;
  configuration.registry = publicUrl(configuration.registry).href.replace(
    /\/?$/,
    "/",
  );
  const source = parseSource(process.argv[2]);
  captureStage = "download";
  const provenance = await capture(source);
  if (
    configuration.registry !== "https://registry.npmjs.org/" ||
    configuration.authentication
  )
    await startRegistry();
  captureStage = "dependencies";
  const manifest = await installDependencies();
  if (registryServer)
    await new Promise((resolve) => registryServer.close(resolve));
  await dispatcher.close();
  captureStage = "inventory";
  // Validate every byte/link before SDK traverses resource directories.
  const entries = JSON.parse(
    (
      await run("python3", [HELPER, "inventory", ROOT], undefined, MAX_JSON)
    ).toString("utf8"),
  );
  captureStage = "resources";
  const resourcePaths = await resources();
  captureStage = "snapshot";
  const snapshot = {
    source: provenance,
    name:
      provenance.kind === "npm"
        ? provenance.name
        : manifest.name ||
          basename(new URL(provenance.url).pathname).replace(/\.git$/, ""),
    version:
      provenance.kind === "npm"
        ? provenance.version
        : (manifest.version ?? null),
    runtime: {
      kind: "pi-sdk",
      piVersion: "0.87.1",
      nodeMajor: 24,
      platform: "linux",
      arch: process.arch,
    },
    root: "package",
    resources: resourcePaths,
    entries,
  };
  const bytes = Buffer.from(JSON.stringify(snapshot));
  if (bytes.length > MAX_JSON) throw Error("manifest_limit");
  for (const [id, channel] of channels) {
    channel.closed = true;
    clearTimeout(channel.timer);
    closedChannels.set(id, channel);
    channel.socket.destroy();
    await send({ type: "close", id });
  }
  channels.clear();
  for (const client of clients) client.destroy();
  await new Promise((resolve) => proxy.close(resolve));
  await outputChain;
  for (let offset = 0; offset < bytes.length; offset += FRAME)
    await send({
      type: "snapshot_chunk",
      data: bytes.subarray(offset, offset + FRAME).toString("base64"),
    });
  await send({
    type: "snapshot_end",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  stopping = true;
  process.stdin.destroy();
}
main().catch(async (error) => {
  process.stderr.write(`Package capture failed at ${captureStage}.\n`);
  await send({
    type: "error",
    code:
      error.message === "pi_extensions_missing"
        ? "pi_extensions_missing"
        : "package_capture_failed",
  });
  fail();
});
