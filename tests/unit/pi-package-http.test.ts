import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type * as Installations from "@/lib/pi-packages/installations";

const mocks = vi.hoisted(() => ({
  principal: vi.fn(),
  workspace: vi.fn(),
  member: vi.fn(),
}));
vi.mock("@/lib/auth/request-user", () => ({
  resolveRequestPrincipal: mocks.principal,
}));
vi.mock("@/lib/db", () => ({
  db: { workspace: { findUnique: mocks.workspace } },
}));
vi.mock("@/lib/pi-packages/installations", async (importOriginal) => {
  const actual = await importOriginal<typeof Installations>();
  return { ...actual, assertPiClientMember: mocks.member };
});

import {
  piInstallationAccountContext,
  piInstallationErrorResponse,
} from "@/lib/pi-packages/http";
import { PiInstallationError } from "@/lib/pi-packages/installations";
import { RequestBodyError } from "@/lib/sandboxes/http-body";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://toolplane.example");
  mocks.principal.mockResolvedValue({
    credential: "session",
    user: { id: "user" },
  });
  mocks.workspace.mockResolvedValue({ id: "workspace" });
});
afterEach(() => vi.unstubAllEnvs());

describe("Pi installation error responses", () => {
  it.each([
    [
      new PiInstallationError("pi_installation_forbidden", 403),
      403,
      "pi_installation_forbidden",
    ],
    [new RequestBodyError(413), 413, "pi_installation_invalid_request"],
    [
      z.object({ value: z.string() }).safeParse({ value: 1 }).error,
      400,
      "pi_installation_invalid_request",
    ],
    [
      { code: "P2002", message: "database private detail" },
      409,
      "pi_installation_conflict",
    ],
    [{ code: "P2034" }, 409, "pi_installation_conflict"],
    [{ code: "P2025" }, 500, "pi_installation_failed"],
    [new Error("secret"), 500, "pi_installation_failed"],
    [null, 500, "pi_installation_failed"],
    ["failure", 500, "pi_installation_failed"],
    [{}, 500, "pi_installation_failed"],
  ])(
    "maps errors to private public responses: %s",
    async (error, status, code) => {
      const response = piInstallationErrorResponse(error);
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      await expect(response.json()).resolves.toEqual({ error: code });
    },
  );
});

describe("Pi installation account authorization", () => {
  it.each([null, { credential: "toolkit-token", user: { id: "user" } }])(
    "rejects unauthorized credentials before workspace lookup",
    async (principal) => {
      mocks.principal.mockResolvedValue(principal);
      await expect(
        piInstallationAccountContext(
          new Request("https://toolplane.example/api/installations"),
          "team",
        ),
      ).rejects.toMatchObject({
        code: "pi_installation_unauthorized",
        status: 401,
      });
      expect(mocks.workspace).not.toHaveBeenCalled();
      expect(mocks.member).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, "https://attacker.example"])(
    "rejects session mutation with origin %s",
    async (origin) => {
      const req = new Request("https://toolplane.example/api/installations", {
        method: "POST",
        headers: origin ? { origin } : {},
      });
      await expect(
        piInstallationAccountContext(req, "team"),
      ).rejects.toMatchObject({
        code: "pi_installation_forbidden",
        status: 403,
      });
      expect(mocks.workspace).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["GET", "session", undefined],
    ["POST", "session", "https://toolplane.example"],
    ["POST", "api-token", undefined],
  ])(
    "allows %s with %s after membership authorization",
    async (method, credential, origin) => {
      mocks.principal.mockResolvedValue({ credential, user: { id: "user" } });
      await expect(
        piInstallationAccountContext(
          new Request("https://toolplane.example/api/installations", {
            method,
            headers: origin ? { origin } : {},
          }),
          "team",
        ),
      ).resolves.toEqual({ workspaceId: "workspace", userId: "user" });
      expect(mocks.workspace).toHaveBeenCalledWith({
        where: { slug: "team" },
        select: { id: true },
      });
      expect(mocks.member).toHaveBeenCalledWith("workspace", "user");
    },
  );
  it("returns not found without trying membership for absent workspaces", async () => {
    mocks.workspace.mockResolvedValue(null);
    await expect(
      piInstallationAccountContext(
        new Request("https://toolplane.example/api/installations"),
        "missing",
      ),
    ).rejects.toMatchObject({ code: "pi_installation_not_found", status: 404 });
    expect(mocks.member).not.toHaveBeenCalled();
  });
  it("propagates membership denial rather than returning account context", async () => {
    const denial = new PiInstallationError("pi_installation_forbidden", 403);
    mocks.member.mockRejectedValue(denial);
    await expect(
      piInstallationAccountContext(
        new Request("https://toolplane.example/api/installations"),
        "team",
      ),
    ).rejects.toBe(denial);
  });
});
