// @vitest-environment node
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ source: vi.fn(), sync: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/skills/registry", () => ({
  defaultTpSkillsSource: m.source,
  syncGithubSkillRegistry: m.sync,
}));
vi.mock("@/lib/observability/http", () => ({
  withRequestLogging: (_path: string, handler: unknown) => handler,
}));
import { POST } from "@/app/api/v1/skill-registries/tp-skills/webhook/route";
function signed(body: unknown, event: string | null = "push") {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return new Request("https://test/webhook", {
    method: "POST",
    body: raw,
    headers: {
      "x-hub-signature-256": `sha256=${createHmac("sha256", "secret").update(raw).digest("hex")}`,
      ...(event ? { "x-github-event": event } : {}),
    },
  });
}
describe("registry webhook authentication and event filtering", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("TP_SKILLS_WEBHOOK_SECRET", "secret");
    m.source.mockReturnValue({ owner: "Owner", repo: "Skills", ref: "main" });
    m.sync.mockResolvedValue({
      found: 4,
      created: 1,
      updated: 2,
      failed: [{ path: "bad", error: "invalid" }],
      commitSha: "abc",
    });
  });
  afterEach(() => vi.unstubAllEnvs());
  it("returns unavailable when no secret is configured", async () => {
    vi.stubEnv("TP_SKILLS_WEBHOOK_SECRET", "");
    expect((await POST(signed({}))).status).toBe(503);
    expect(m.sync).not.toHaveBeenCalled();
  });
  it.each([null, "sha1=abc", "sha256=00", `sha256=${"00".repeat(32)}`])(
    "rejects invalid signature %s",
    async (signature) => {
      const req = new Request("https://test/webhook", {
        method: "POST",
        body: "{}",
        headers: signature ? { "x-hub-signature-256": signature } : {},
      });
      expect((await POST(req)).status).toBe(401);
      expect(m.source).not.toHaveBeenCalled();
    },
  );
  it("answers a verified ping without parsing its body", async () => {
    const response = await POST(signed("not-json", "ping"));
    expect(await response.json()).toEqual({ ok: true, event: "ping" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it.each(["issues", null])("ignores event %s", async (event) => {
    expect(await (await POST(signed({}, event))).json()).toEqual({
      ok: true,
      ignored: true,
      event,
    });
    expect(m.sync).not.toHaveBeenCalled();
  });
  it("rejects signed malformed push JSON", async () => {
    expect((await POST(signed("{"))).status).toBe(400);
  });
  it.each([
    {},
    { repository: {} },
    { repository: { full_name: "foreign/skills" } },
  ])("ignores repository mismatch %j", async (body) => {
    expect(await (await POST(signed(body))).json()).toMatchObject({
      ignored: true,
      reason: "repository mismatch",
    });
    expect(m.sync).not.toHaveBeenCalled();
  });
  it.each([undefined, "refs/heads/other"])(
    "ignores non-target ref %s",
    async (ref) => {
      expect(
        await (
          await POST(signed({ repository: { full_name: "OWNER/SKILLS" }, ref }))
        ).json(),
      ).toMatchObject({ ignored: true, reason: "ref mismatch" });
      expect(m.sync).not.toHaveBeenCalled();
    },
  );
  it.each(["main", "refs/heads/main"])(
    "syncs a verified push using configured ref %s",
    async (ref) => {
      m.source.mockReturnValue({ owner: "Owner", repo: "Skills", ref });
      expect(
        await (
          await POST(
            signed({
              repository: { full_name: "OWNER/SKILLS" },
              ref: "refs/heads/main",
            }),
          )
        ).json(),
      ).toEqual({
        ok: true,
        found: 4,
        created: 1,
        updated: 2,
        failed: 1,
        commitSha: "abc",
        failures: [{ path: "bad", error: "invalid" }],
      });
      expect(m.sync).toHaveBeenCalledWith(
        {},
        { owner: "Owner", repo: "Skills", ref },
      );
    },
  );
});
