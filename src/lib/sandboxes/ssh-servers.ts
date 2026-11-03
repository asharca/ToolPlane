import "server-only";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { db } from "@/lib/db";
import { publicRemoteAddress } from "@/lib/a2a/remote-network";
import { resolveSshPrivateHostsSettings } from "@/lib/admin/settings";
import { decryptSecretText, encryptSecretText } from "@/lib/security/secrets";
import {
  isPrivateRemoteMcpIp,
  normalizeRemoteMcpHostname,
  parseRemoteMcpPrivateHosts,
} from "../../../scripts/remote-mcp-private-hosts.mjs";
import {
  sshArguments,
  sshEnvironment,
} from "../../../scripts/ssh-sandbox-adapter.mjs";

export type SshServerErrorCode =
  | "SSH_INVALID_INPUT"
  | "SSH_HOST_UNRESOLVED"
  | "SSH_HOST_FORBIDDEN"
  | "SSH_HOST_PRIVATE_NOT_ALLOWED"
  | "SSH_HOST_UNREACHABLE"
  | "SSH_HOST_KEY_MISMATCH"
  | "SSH_AUTH_FAILED"
  | "SSH_CREDENTIAL_INVALID"
  | "SSH_REMOTE_NOT_READY"
  | "SSH_CONNECT_FAILED"
  | "SSH_NOT_CONFIGURED";

const STATUS: Record<SshServerErrorCode, number> = {
  SSH_INVALID_INPUT: 400,
  SSH_HOST_UNRESOLVED: 422,
  SSH_HOST_FORBIDDEN: 403,
  SSH_HOST_PRIVATE_NOT_ALLOWED: 403,
  SSH_HOST_UNREACHABLE: 422,
  SSH_HOST_KEY_MISMATCH: 422,
  SSH_AUTH_FAILED: 422,
  SSH_CREDENTIAL_INVALID: 400,
  SSH_REMOTE_NOT_READY: 422,
  SSH_CONNECT_FAILED: 422,
  SSH_NOT_CONFIGURED: 409,
};

export class SshServerError extends Error {
  readonly status: number;
  constructor(readonly code: SshServerErrorCode) {
    super(code);
    this.name = "SshServerError";
    this.status = STATUS[code];
  }
}

// Same syntax the OpenSSH adapter accepts; never an option-looking value.
export const SshHost = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9.:-]{0,252}$/);
export const SshPort = z.number().int().min(1).max(65535);
const SshUsername = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/);
const SshRoot = z
  .string()
  .min(1)
  .max(2048)
  .startsWith("/")
  .refine(
    (value) =>
      !/[^\x20-\uFFFF]|[\x7f\\]/.test(value) &&
      !value.split("/").includes(".."),
  );
// Prompt answers are single askpass lines.
const PromptSecret = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[^\r\n\0]+$/);
const HOST_KEY_TYPES = [
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "ssh-rsa",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com",
] as const;
export const SshHostKey = z
  .object({
    type: z.enum(HOST_KEY_TYPES),
    key: z
      .string()
      .min(16)
      .max(16_384)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();
export type SshHostKey = z.infer<typeof SshHostKey>;

export const SshServerInput = z
  .object({
    host: SshHost,
    port: SshPort.default(22),
    username: SshUsername,
    root: SshRoot,
    auth: z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("key"),
          privateKey: z.string().min(64).max(32_768),
          passphrase: PromptSecret.optional(),
        })
        .strict(),
      z
        .object({ type: z.literal("password"), password: PromptSecret })
        .strict(),
    ]),
    hostKeys: z.array(SshHostKey).min(1).max(16),
  })
  .strict();
export type SshServerInput = z.infer<typeof SshServerInput>;

/** OpenSSH requires LF line endings and a trailing newline; PuTTY keys are not supported. */
function normalizePrivateKey(value: string): string {
  const key = `${value.replace(/\r\n?/g, "\n").trim()}\n`;
  if (
    !/^-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----\n[\s\S]+\n-----END (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----\n$/.test(
      key,
    )
  )
    throw new SshServerError("SSH_CREDENTIAL_INVALID");
  return key;
}

export function sshHostKeyFingerprint(key: string): string {
  return `SHA256:${createHash("sha256")
    .update(Buffer.from(key, "base64"))
    .digest("base64")
    .replace(/=+$/, "")}`;
}

function unmapIpv4(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return mapped?.[1] ?? address;
}

/**
 * Resolve once and connect to that exact address. Public addresses are
 * allowed; RFC1918/ULA only when an administrator lists the host or address;
 * loopback, link-local, metadata and other special ranges never.
 */
export async function resolveSshAddress(host: string): Promise<string> {
  const name = normalizeRemoteMcpHostname(host);
  if (name === "localhost" || name.endsWith(".localhost"))
    throw new SshServerError("SSH_HOST_FORBIDDEN");
  let addresses: string[];
  if (isIP(name)) addresses = [name];
  else {
    try {
      addresses = (await lookup(name, { all: true, verbatim: true })).map(
        (entry) => entry.address,
      );
    } catch {
      throw new SshServerError("SSH_HOST_UNRESOLVED");
    }
  }
  if (!addresses.length) throw new SshServerError("SSH_HOST_UNRESOLVED");
  let allow: ReturnType<typeof parseRemoteMcpPrivateHosts> | undefined;
  for (const raw of addresses.map(unmapIpv4)) {
    if (publicRemoteAddress(raw)) continue;
    if (!isPrivateRemoteMcpIp(raw))
      throw new SshServerError("SSH_HOST_FORBIDDEN");
    allow ??= parseRemoteMcpPrivateHosts(
      (await resolveSshPrivateHostsSettings()).value,
    );
    const listed =
      allow &&
      (allow.ips.has(raw) ||
        allow.hosts.has(name) ||
        [...allow.suffixes].some((suffix) => name.endsWith(`.${suffix}`)));
    if (!listed) throw new SshServerError("SSH_HOST_PRIVATE_NOT_ALLOWED");
  }
  return unmapIpv4(addresses[0] as string);
}

/** Read the server's host keys for the user to confirm before anything is stored. */
export async function scanSshHostKeys(host: string, port: number) {
  const address = await resolveSshAddress(host);
  const scan = Promise.withResolvers<string>();
  execFile(
    "/usr/bin/ssh-keyscan",
    ["-T", "5", "-p", String(port), "-t", "ed25519,ecdsa,rsa", address],
    {
      timeout: 20_000,
      maxBuffer: 256 * 1024,
      env: { PATH: "/usr/bin:/bin", NODE_ENV: process.env.NODE_ENV },
    },
    (_error, out) => scan.resolve(typeof out === "string" ? out : ""),
  );
  const stdout = await scan.promise;
  const hostKeys: Array<SshHostKey & { fingerprint: string }> = [];
  for (const line of stdout.split("\n")) {
    const [, type, key] = line.trim().split(/\s+/);
    const parsed = SshHostKey.safeParse({ type, key });
    if (
      !line.startsWith("#") &&
      parsed.success &&
      !hostKeys.some((entry) => entry.key === parsed.data.key)
    )
      hostKeys.push({
        ...parsed.data,
        fingerprint: sshHostKeyFingerprint(parsed.data.key),
      });
  }
  if (!hostKeys.length) throw new SshServerError("SSH_HOST_UNREACHABLE");
  return { address, hostKeys };
}

const HOST_KEY_ALIAS = "toolplane-ssh-server";

type DecryptedSshServer = {
  host: string;
  port: number;
  username: string;
  root: string;
  hostKeys: SshHostKey[];
  authType: "key" | "password";
  secret: string;
  passphrase?: string;
};

/**
 * Write one private credential directory (0700, files 0600, askpass 0700)
 * and return the adapter configuration. The caller owns its removal.
 */
async function materialize(
  directory: string,
  server: DecryptedSshServer,
  address: string,
) {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const knownHostsFile = path.join(directory, "known_hosts");
  // Keys are pinned to a fixed alias, so a changed DNS answer cannot reuse them.
  await writeFile(
    knownHostsFile,
    server.hostKeys
      .map((entry) => `${HOST_KEY_ALIAS} ${entry.type} ${entry.key}\n`)
      .join(""),
    { mode: 0o600 },
  );
  let identityFile: string | undefined;
  if (server.authType === "key") {
    identityFile = path.join(directory, "id");
    await writeFile(identityFile, server.secret, { mode: 0o600 });
  }
  const prompt =
    server.authType === "password" ? server.secret : server.passphrase;
  let askpassFile: string | undefined;
  if (prompt !== undefined) {
    const secretFile = path.join(directory, "prompt");
    await writeFile(secretFile, `${prompt}\n`, { mode: 0o600 });
    askpassFile = path.join(directory, "askpass");
    await writeFile(askpassFile, `#!/bin/sh\nexec /bin/cat ${secretFile}\n`, {
      mode: 0o700,
    });
  }
  return {
    host: address,
    port: server.port,
    username: server.username,
    root: server.root,
    authType: server.authType,
    knownHostsFile,
    hostKeyAlias: HOST_KEY_ALIAS,
    ...(identityFile ? { identityFile } : {}),
    ...(askpassFile ? { askpassFile } : {}),
  };
}

function inputToServer(input: SshServerInput): DecryptedSshServer {
  return {
    host: input.host,
    port: input.port,
    username: input.username,
    root: input.root,
    hostKeys: input.hostKeys,
    authType: input.auth.type,
    secret:
      input.auth.type === "key"
        ? normalizePrivateKey(input.auth.privateKey)
        : input.auth.password,
    ...(input.auth.type === "key" && input.auth.passphrase
      ? { passphrase: input.auth.passphrase }
      : {}),
  };
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** One real login with the exact runtime arguments; classifies the failure without echoing it. */
async function verifyLogin(server: DecryptedSshServer) {
  const address = await resolveSshAddress(server.host);
  const directory = path.join(os.tmpdir(), "toolplane-ssh-check", randomUUID());
  try {
    const config = await materialize(directory, server, address);
    const done = Promise.withResolvers<number | null>();
    const child = spawn(
      "/usr/bin/ssh",
      sshArguments(
        config,
        `test -d ${quote(server.root)} && command -v python3 >/dev/null`,
      ),
      {
        shell: false,
        env: { ...sshEnvironment(config), NODE_ENV: process.env.NODE_ENV },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 8192) stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
    child.on("error", () => done.resolve(null));
    child.on("close", (code) => {
      clearTimeout(timer);
      done.resolve(code);
    });
    const code = await done.promise;
    if (code === 0) return;
    if (code === 1) throw new SshServerError("SSH_REMOTE_NOT_READY");
    if (/host key verification failed|remote host identification/i.test(stderr))
      throw new SshServerError("SSH_HOST_KEY_MISMATCH");
    if (
      /load key|invalid format|incorrect passphrase|bad passphrase/i.test(
        stderr,
      )
    )
      throw new SshServerError("SSH_CREDENTIAL_INVALID");
    if (/permission denied|too many authentication failures/i.test(stderr))
      throw new SshServerError("SSH_AUTH_FAILED");
    throw new SshServerError("SSH_CONNECT_FAILED");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Validate, test the login, then return the row to store (secrets encrypted). */
export async function prepareSshServerRecord(input: SshServerInput) {
  const server = inputToServer(input);
  await verifyLogin(server);
  return {
    host: server.host,
    port: server.port,
    username: server.username,
    root: server.root,
    hostKeys: server.hostKeys,
    authType: server.authType,
    encryptedSecret: encryptSecretText(server.secret),
    encryptedPassphrase: server.passphrase
      ? encryptSecretText(server.passphrase)
      : null,
  };
}

export function sshRuntimeDirectory(deploymentId: string): string {
  return path.join(
    os.tmpdir(),
    "toolplane-ssh",
    createHash("sha256").update(deploymentId).digest("hex").slice(0, 32),
  );
}

/** Materialize the stored credentials for one sandbox runtime launch. */
export async function prepareSshRuntime(input: {
  sandboxId: string;
  workspaceId: string;
  deploymentId: string;
}) {
  const row = await db.sandboxSshServer.findFirst({
    where: {
      sandboxId: input.sandboxId,
      sandbox: {
        workspaceId: input.workspaceId,
        deploymentId: input.deploymentId,
      },
    },
  });
  if (!row) throw new SshServerError("SSH_NOT_CONFIGURED");
  const hostKeys = z.array(SshHostKey).min(1).parse(row.hostKeys);
  const address = await resolveSshAddress(row.host);
  const directory = sshRuntimeDirectory(input.deploymentId);
  const config = await materialize(
    directory,
    {
      host: row.host,
      port: row.port,
      username: row.username,
      root: row.root,
      hostKeys,
      authType: row.authType === "password" ? "password" : "key",
      secret: decryptSecretText(row.encryptedSecret),
      ...(row.encryptedPassphrase
        ? { passphrase: decryptSecretText(row.encryptedPassphrase) }
        : {}),
    },
    address,
  );
  return { config, directory };
}

export async function removeSshRuntimeDirectory(directory: string) {
  await rm(directory, { recursive: true, force: true }).catch(() => undefined);
}
