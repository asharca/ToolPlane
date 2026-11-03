import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function stopNativeSessionHost(statePath) {
  const socketPath = `/tmp/toolplane-runtime-${createHash("sha256").update(statePath).digest("hex").slice(0, 32)}.sock`;
  const deadline = Date.now() + 10_000;
  await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("PI_SDK_SHUTDOWN_TIMEOUT"));
    }, 10_000);
    socket.once("connect", () => {
      // A deliberately different signature makes both deployed and current brokers
      // stop their own process group. It never starts a host or replays a turn.
      socket.write(
        `${JSON.stringify({ kind: "pi-sdk", statePath, signature: `shutdown:${randomUUID()}` })}\n`,
      );
    });
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.includes('"PI_SDK_BUSY"')) {
        socket.destroy();
        reject(new Error("PI_SDK_BUSY"));
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      if (error.code === "ENOENT") resolve();
      else if (error.code === "ECONNREFUSED")
        unlink(socketPath).then(resolve, (error) =>
          error.code === "ENOENT" ? resolve() : reject(error),
        );
      else reject(error);
    });
    socket.once("end", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("close", () => clearTimeout(timer));
  });
  for (;;) {
    try {
      await lstat(socketPath);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (Date.now() >= deadline) throw new Error("PI_SDK_SHUTDOWN_TIMEOUT");
    await delay(20);
  }
}
export async function stopNativeSessionHosts(stateRoot) {
  const ids = new Set();
  for (const directory of [
    join(stateRoot, "host"),
    join(stateRoot, "sessions"),
  ]) {
    let entries;
    try {
      entries = await readdir(directory);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const name of entries) {
      const match = /^([A-Za-z0-9_-]{1,200})\.json$/.exec(name);
      if (match) ids.add(match[1]);
    }
  }
  await Promise.all(
    [...ids].map((id) =>
      stopNativeSessionHost(join(stateRoot, "sessions", `${id}.json`)),
    ),
  );
}
if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
)
  await stopNativeSessionHosts(process.argv[2]);
