// @vitest-environment node
import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { db } from "@/lib/db";
import { encryptSecretText } from "@/lib/security/secrets";
import { GET } from "@/app/api/v1/agents/[agentId]/conversations/[conversationId]/export/route";

const actor = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth/request-user", () => ({
  resolveRequestUser: async () => (actor.id ? { id: actor.id } : null),
}));
const stamp = randomUUID();
let ownerId = "",
  memberId = "",
  outsiderId = "",
  workspaceId = "";
let agentId = "",
  otherAgentId = "",
  conversationId = "";
const secret = `opaque-environment-${stamp}`;
const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJ0b29scGxhbmUifQ.signature";

beforeAll(async () => {
  const users = await Promise.all(
    ["owner", "member", "outsider"].map((role) =>
      db.user.create({
        data: {
          email: `export-${role}-${stamp}@example.invalid`,
          passwordHash: "fixture",
        },
      }),
    ),
  );
  [ownerId, memberId, outsiderId] = users.map((user) => user.id);
  workspaceId = (
    await db.workspace.create({
      data: {
        slug: `session-export-${stamp}`,
        name: "Session export",
        ownerId,
        members: { create: { userId: memberId, role: "member" } },
      },
    })
  ).id;
  agentId = (
    await db.agent.create({
      data: {
        workspaceId,
        name: "Historical",
        slug: "historical",
        runtimeKind: "omp",
      },
    })
  ).id;
  otherAgentId = (
    await db.agent.create({
      data: {
        workspaceId,
        name: "Other",
        slug: "other",
        runtimeKind: "pi-sdk",
      },
    })
  ).id;
  conversationId = (
    await db.conversation.create({
      data: {
        agentId,
        title: "中文会话导出",
        messages: {
          create: [
            {
              role: "user",
              parts: [{ type: "text", text: "Retained request" }],
            },
            {
              role: "assistant",
              parts: [
                {
                  type: "work-tool",
                  toolName: "bash",
                  status: "failed",
                  isError: true,
                  input: { command: "read configuration" },
                  output: `Bearer ${jwt}\n${secret}`,
                },
                { type: "text", text: `Retained answer ${secret} ${jwt}` },
              ],
            },
          ],
        },
      },
    })
  ).id;
});
beforeEach(() => {
  actor.id = ownerId;
});
afterAll(async () => {
  if (workspaceId) {
    await db.workspace.delete({ where: { id: workspaceId } });
  }
  await db.user.deleteMany({
    where: { id: { in: [ownerId, memberId, outsiderId].filter(Boolean) } },
  });
  await db.$disconnect();
});
async function download(format = "md", agent = agentId) {
  return GET(
    new Request(
      `http://localhost/api/v1/agents/${agent}/conversations/${conversationId}/export?format=${format}`,
    ),
    {
      params: Promise.resolve({ agentId: agent, conversationId }),
    },
  );
}

describe("conversation export authorization and retained history", () => {
  it("requires an account identity", async () => {
    actor.id = "";
    expect((await download()).status).toBe(401);
  });
  it("hides another workspace's conversation", async () => {
    actor.id = outsiderId;
    const response = await download();
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("Retained");
  });
  it("rejects a conversation not belonging to the URL Agent", async () => {
    const response = await download("md", otherAgentId);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("Retained");
  });
  it("allows workspace members to download read-only history with tool summaries and redaction", async () => {
    actor.id = memberId;
    const rollback = new Error("export credential fixture rollback");
    await expect(
      db.$transaction(async (tx) => {
        const id = randomUUID();
        await tx.agentEnvironmentCredential.create({
          data: {
            id,
            workspaceId,
            agentId,
            name: "EXPORT_SECRET",
            revokedAt: new Date(),
            encryptedValue: encryptSecretText(
              JSON.stringify({
                id,
                workspaceId,
                agentId,
                name: "EXPORT_SECRET",
                value: secret,
              }),
            ),
          },
        });
        // Keep actual credential queries within the rollback transaction; never
        // delete retained credential rows or disable their database constraints.
        const query = vi
          .spyOn(db.agentEnvironmentCredential, "findMany")
          .mockImplementation(
            tx.agentEnvironmentCredential.findMany.bind(
              tx.agentEnvironmentCredential,
            ),
          );
        try {
          const response = await download();
          expect(response.status).toBe(200);
          expect(response.headers.get("cache-control")).toBe("no-store");
          const disposition = response.headers.get("content-disposition") ?? "";
          expect(disposition).toContain("filename*=UTF-8''%E4%B8%AD%E6%96%87");
          expect(disposition).toMatch(/filename="[\x20-\x7e]+"/);
          const text = await response.text();
          expect(text).toContain("Retained request");
          expect(text).toContain("Retained answer");
          expect(text).toContain("Tool: bash — failed");
          expect(text).toContain("read configuration");
          expect(text).toContain("[REDACTED]");
          expect(text).not.toContain(secret);
          expect(text).not.toContain(jwt);
        } finally {
          query.mockRestore();
        }
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
  it("reports native-format unavailability without starting a historical runtime", async () => {
    for (const format of ["jsonl", "html"]) {
      const response = await download(format);
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe(
        "SESSION_EXPORT_NATIVE_UNAVAILABLE",
      );
    }
  });
  it("rejects unsupported formats", async () => {
    const response = await download("zip");
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("SESSION_EXPORT_FORMAT_INVALID");
  });
  it("fails oversized exports without sending a partial download", async () => {
    const message = await db.message.create({
      data: {
        conversationId,
        role: "user",
        parts: [{ type: "text", text: "x".repeat(8 * 1024 * 1024) }],
      },
    });
    try {
      const response = await download();
      expect(response.status).toBe(413);
      expect((await response.json()).code).toBe("SESSION_EXPORT_TOO_LARGE");
      expect(response.headers.get("content-disposition")).toBeNull();
    } finally {
      await db.message.delete({ where: { id: message.id } });
    }
  });
});
