// Trusted relay. The first stdin line is private launch configuration; subsequent
// bytes are MCP. Neither broker credentials nor the MCP env belong in argv.
import { once } from "node:events";
import { randomUUID } from "node:crypto";

async function relay() {
  const input = process.stdin[Symbol.asyncIterator]();
  let bytes = Buffer.alloc(0);
  let end = bytes.indexOf(10);
  while (end < 0) {
    const chunk = await input.next();
    if (chunk.done || bytes.length > 512_000) throw new Error();
    bytes = Buffer.concat([bytes, chunk.value]);
    end = bytes.indexOf(10);
  }
  const { url, token, ...launch } = JSON.parse(bytes.subarray(0, end));
  const id = randomUUID();
  const request = async (op, args = {}) => {
    const res = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "content-type": "application/json",
        "x-connector-broker-token": token,
      },
      body: JSON.stringify({
        op: `mcp_stdio_${op}`,
        args: { ...args, id },
        timeoutMs: 8000,
      }),
    });
    if (!res.ok) throw new Error();
    return (await res.json()).result;
  };
  let stopped = false;
  const write = (data) => request("write", { data: data.toString("base64") });
  try {
    await request("open", launch);
    await Promise.race([
      (async () => {
        if (end + 1 < bytes.length) await write(bytes.subarray(end + 1));
        while (!stopped) {
          const chunk = await input.next();
          if (chunk.done) return;
          await write(chunk.value);
        }
      })(),
      (async () => {
        while (!stopped) {
          const { data, exited } = await request("read");
          if (data && !process.stdout.write(Buffer.from(data, "base64")))
            await once(process.stdout, "drain");
          if (exited) return;
        }
      })(),
    ]);
  } finally {
    stopped = true;
    process.stdin.destroy();
    await request("close");
  }
}
relay().catch(() => {
  process.exitCode = 1;
});
