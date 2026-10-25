// @vitest-environment node
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { nativeApprovalAdapter } from "@/lib/agents/native-tool-approval";
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});
async function hook(
  response: (req: IncomingMessage, res: ServerResponse) => void,
  event: unknown = {
    toolName: "bash",
    input: { command: "printf approved" },
    callId: "native-call",
  },
  options: {
    sdk?: boolean; // Include SDK session startup readiness before the tool check.
    url?: (origin: string) => string;
    token?: string;
  } = {},
) {
  const server = createServer(response);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  closers.push(
    () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error();
  const origin = `http://127.0.0.1:${address.port}`;
  const args = [
    "--input-type=module",
    "-e",
    `
      const {approvalReady,approveNativeTool}=await import(process.env.APPROVAL_HELPER_URL);
      try {
        const invocation=JSON.parse(process.env.APPROVAL_EVENT);
        const ready=process.env.APPROVAL_READY==="1";
        if(ready) await approvalReady();
        const allowed=await approveNativeTool(invocation.toolName,invocation.input,invocation.callId);
        process.stdout.write(JSON.stringify(ready?{ready:true,allowed}:{allowed})+"\\n");
        if(!allowed) process.exitCode=2;
      } catch {
        process.stderr.write("approval-denied\\n");
        process.exitCode=2;
      }
    `,
  ];
  return new Promise<{ code: number | null; out: string; err: string }>(
    (done, reject) => {
      const child = spawn(process.execPath, args, {
        env: {
          ...process.env,
          TOOLPLANE_APPROVAL_URL:
            options.url?.(origin) ??
            `${origin}/api/v1/agent-runtime/a2a/test/approvals`,
          TOOLPLANE_RUNTIME_TOKEN:
            options.token ?? "test-only-runtime-credential",
          APPROVAL_HELPER_URL: pathToFileURL(
            resolve("scripts/a2a-native-approval.mjs"),
          ).href,
          APPROVAL_EVENT:
            typeof event === "string" ? event : JSON.stringify(event),
          APPROVAL_READY: options.sdk ? "1" : "0",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "",
        err = "";
      child.stdout.on("data", (v) => {
        out += v;
      });
      child.stderr.on("data", (v) => {
        err += v;
      });
      child.on("error", reject);
      child.on("exit", (code) => done({ code, out, err }));
      child.stdin.end();
    },
  );
}
describe("native pre-tool approval process", () => {
  it("uses a real subprocess and HTTP boundary to allow an exact approved invocation", async () => {
    let raw = "",
      authorization: string | undefined;
    const result = await hook((req, res) => {
      authorization = req.headers.authorization;
      req.on("data", (value) => {
        raw += value;
      });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"status":"allow"}');
      });
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(raw)).toEqual({
      action: "check",
      callId: "native-call",
      toolName: "bash",
      input: { command: "printf approved" },
    });
    expect(authorization).toBe("Bearer test-only-runtime-credential");
    expect(JSON.parse(result.out).allowed).toBe(true);
    expect(result.out + result.err).not.toContain(
      "test-only-runtime-credential",
    );
  });
  it.each([
    "/api/v1/agent-runtime/sessions/approvals",
    "/api/v1/agent-runtime/a2a/test/approvals",
  ])("runs the actual SDK helper ready/check sequence at %s", async (path) => {
    const requests: Array<{
      path: string;
      authorization: string | undefined;
      body: unknown;
    }> = [];
    const result = await hook(
      (req, res) => {
        let raw = "";
        req.on("data", (value) => {
          raw += value;
        });
        req.on("end", () => {
          const body = JSON.parse(raw);
          requests.push({
            path: req.url ?? "",
            authorization: req.headers.authorization,
            body,
          });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              status: body.action === "ready" ? "ready" : "allow",
            }),
          );
        });
      },
      undefined,
      { sdk: true, url: (origin) => `${origin}${path}` },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ ready: true, allowed: true });
    expect(requests).toEqual([
      {
        path,
        authorization: "Bearer test-only-runtime-credential",
        body: { action: "ready" },
      },
      {
        path,
        authorization: "Bearer test-only-runtime-credential",
        body: {
          action: "check",
          callId: "native-call",
          toolName: "bash",
          input: { command: "printf approved" },
        },
      },
    ]);
    expect(result.out + result.err).not.toContain(
      "test-only-runtime-credential",
    );
  });

  it("requires a ready receipt before any SDK tool approval check", async () => {
    const bodies: unknown[] = [];
    const result = await hook(
      (req, res) => {
        let raw = "";
        req.on("data", (value) => {
          raw += value;
        });
        req.on("end", () => {
          bodies.push(JSON.parse(raw));
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"status":"allow"}');
        });
      },
      undefined,
      {
        sdk: true,
        url: (origin) => `${origin}/api/v1/agent-runtime/sessions/approvals`,
      },
    );
    expect(result.code).toBe(2);
    expect(bodies).toEqual([{ action: "ready" }]);
  });

  it("keeps an explicitly denied session tool call denied after readiness", async () => {
    const actions: string[] = [];
    const result = await hook(
      (req, res) => {
        let raw = "";
        req.on("data", (value) => {
          raw += value;
        });
        req.on("end", () => {
          const body = JSON.parse(raw);
          actions.push(body.action);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              status: body.action === "ready" ? "ready" : "deny",
            }),
          );
        });
      },
      undefined,
      {
        sdk: true,
        url: (origin) => `${origin}/api/v1/agent-runtime/sessions/approvals`,
      },
    );
    expect(result.code).toBe(2);
    expect(JSON.parse(result.out)).toEqual({ ready: true, allowed: false });
    expect(actions).toEqual(["ready", "check"]);
    expect(result.out + result.err).not.toContain(
      "test-only-runtime-credential",
    );
  });

  it.each([
    "/api/v1/agent-runtime/sessions/approvals/",
    "/api/v1/agent-runtime/sessions/approvals/extra",
    "/api/v1/agent-runtime/sessions/test/approvals",
    "/api/v1/agent-runtime/session/approvals",
    "/api/v1/agent-runtime/sessions/approvals?next=other",
    "/api/v1/agent-runtime/sessions/approvals#other",
    "/api/v1/agent-runtime/unrelated/approvals",
  ])(
    "rejects non-exact or decorated session approval URL %s before sending credentials",
    async (path) => {
      let requests = 0;
      const result = await hook(
        (_req, res) => {
          requests++;
          res.end();
        },
        undefined,
        {
          sdk: true,
          url: (origin) => `${origin}${path}`,
        },
      );
      expect(result.code).toBe(2);
      expect(requests).toBe(0);
      expect(result.out + result.err).not.toContain(
        "test-only-runtime-credential",
      );
    },
  );

  it.each(["embedded-credentials", "unsupported-protocol", "missing-token"])(
    "preserves SDK approval URL/credential refusal for %s",
    async (failure) => {
      let requests = 0;
      const result = await hook(
        (_req, res) => {
          requests++;
          res.end();
        },
        undefined,
        {
          sdk: true,
          token: failure === "missing-token" ? "" : undefined,
          url: (origin) => {
            const url = new URL(
              `${origin}/api/v1/agent-runtime/sessions/approvals`,
            );
            if (failure === "embedded-credentials") {
              url.username = "forbidden";
              url.password = "secret";
            }
            if (failure === "unsupported-protocol") url.protocol = "ftp:";
            return url.href;
          },
        },
      );
      expect(result.code).toBe(2);
      expect(requests).toBe(0);
      expect(result.out + result.err).not.toContain(
        "test-only-runtime-credential",
      );
    },
  );

  it("does not follow session approval redirects or deliver the credential to the redirect target", async () => {
    const paths: string[] = [];
    const result = await hook(
      (req, res) => {
        paths.push(req.url ?? "");
        res.writeHead(302, { location: "/credential-leak" });
        res.end();
      },
      undefined,
      {
        sdk: true,
        url: (origin) => `${origin}/api/v1/agent-runtime/sessions/approvals`,
      },
    );
    expect(result.code).toBe(2);
    expect(paths).toEqual(["/api/v1/agent-runtime/sessions/approvals"]);
    expect(result.out + result.err).not.toContain(
      "test-only-runtime-credential",
    );
  });
  it.each(["deny", "unexpected", "expired"])(
    "fails closed for %s without approving native tool execution",
    async (status) => {
      const result = await hook((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status }));
      });
      expect(result.code).toBe(2);
      expect(JSON.parse(result.out).allowed).toBe(false);
    },
  );
  it("fails closed on an uncertain approval delivery without retrying the business operation", async () => {
    let calls = 0;
    const result = await hook((req) => {
      calls++;
      req.socket.destroy();
    });
    expect(result.code).toBe(2);
    expect(calls).toBe(1);
  });
  it("rejects redirects without forwarding the runtime credential", async () => {
    const result = await hook((_req, res) => {
      res.writeHead(302, { location: "http://127.0.0.1:1/credential-leak" });
      res.end();
    });
    expect(result.code).toBe(2);
  });
  it.each(["", "x".repeat(201), null])(
    "rejects invalid native tool name %j before HTTP",
    async (toolName) => {
      let calls = 0;
      const result = await hook(
        (_req, res) => {
          calls++;
          res.end();
        },
        { toolName, input: {}, callId: "invalid-call" },
      );
      expect(result.code).toBe(2);
      expect(JSON.parse(result.out).allowed).toBe(false);
      expect(calls).toBe(0);
    },
  );
  it("rejects an oversized native approval payload without dispatch", async () => {
    let calls = 0;
    const result = await hook(
      (_req, res) => {
        calls++;
        res.end();
      },
      {
        toolName: "bash",
        input: { command: "x".repeat(20_000) },
        callId: "oversized-call",
      },
    );
    expect(result.code).toBe(2);
    expect(JSON.parse(result.out).allowed).toBe(false);
    expect(calls).toBe(0);
  });
  it("places the native Pi hook before execution with frozen arguments and durable call identity", () => {
    const pi = nativeApprovalAdapter("/tmp/approval.mjs");
    expect(pi).toContain("pi.on('tool_call'");
    expect(pi).toContain("event.toolCallId");
    expect(pi).toContain("freezeArguments(event.input)");
    expect(pi).toContain("block: true");
    expect(pi).toContain("await approvalReady()");
  });
});
