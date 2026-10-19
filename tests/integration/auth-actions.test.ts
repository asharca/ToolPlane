// @vitest-environment node
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { getSessionUserId } from "@/lib/auth/session";
import { verifyApiToken } from "@/lib/auth/tokens";
import {
  generatePasswordResetToken,
  hashPasswordResetToken,
  passwordResetExpiry,
} from "@/lib/auth/password-reset-token";
import {
  changePasswordAction,
  createTokenAction,
  loginAction,
  logoutAction,
  resetPasswordAction,
  revokeTokenAction,
  signupAction,
  forgotPasswordAction,
} from "@/lib/auth/actions";

const browser = vi.hoisted(() => ({ values: new Map<string, string>() }));
const deferred = vi.hoisted(() => ({
  tasks: [] as Array<() => Promise<void>>,
}));
vi.mock("next/server", () => ({
  after: (callback: () => Promise<void>) => deferred.tasks.push(callback),
}));
vi.mock("@/lib/auth/password-reset-mail", () => ({
  passwordResetEmailConfigured: () => true,
  sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (key: string) =>
      browser.values.has(key) ? { value: browser.values.get(key) } : undefined,
    set: (key: string, value: string) => browser.values.set(key, value),
    delete: (key: string) => browser.values.delete(key),
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));

const prefix = `auth-actions-${randomUUID()}`;
const password = "initial-password-123";
let sequence = 0;
function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}
async function account(
  extra: { status?: "active" | "suspended"; locale?: string } = {},
) {
  return db.user.create({
    data: {
      email: `${prefix}-${sequence++}@test.invalid`,
      passwordHash: await hashPassword(password),
      ...extra,
    },
  });
}
beforeEach(() => {
  browser.values.clear();
  deferred.tasks.length = 0;
});
afterAll(async () => {
  await db.user.deleteMany({ where: { email: { startsWith: prefix } } });
});

describe("authentication actions at the persistence boundary", () => {
  it("normalizes signup input, hashes the password and creates a verifiable session", async () => {
    const email = `${prefix}-${sequence++}@test.invalid`;
    await expect(
      signupAction(
        {},
        form({
          email: ` ${email.toUpperCase()} `,
          name: " Alice ",
          password,
          detectedTimeZone: "Asia/Shanghai",
          next: "/app/team",
        }),
      ),
    ).rejects.toThrow("redirect:/app/team");
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    expect(user.name).toBe("Alice");
    expect(user.detectedTimeZone).toBe("Asia/Shanghai");
    expect(user.passwordHash).not.toBe(password);
    expect(await verifyPassword(password, user.passwordHash)).toBe(true);
    expect(await getSessionUserId()).toBe(user.id);
  });

  it("rejects duplicate signup without replacing the account or creating a session", async () => {
    const user = await account();
    expect(
      await signupAction({}, form({ email: user.email, name: "", password })),
    ).toEqual({ error: "emailAlreadyExists" });
    expect(await getSessionUserId()).toBeNull();
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: user.id } }))
        .passwordHash,
    ).toBe(user.passwordHash);
  });

  it.each([
    [{ email: "bad", name: "", password }, "invalidEmail"],
    [
      { email: "a@test.invalid", name: "x".repeat(161), password },
      "nameTooLong",
    ],
    [
      { email: "a@test.invalid", name: "", password: "short" },
      "passwordTooShort",
    ],
    [
      { email: "a@test.invalid", name: "", password: "x".repeat(129) },
      "passwordTooLong",
    ],
  ])(
    "rejects invalid signup input before authentication: %j",
    async (values, error) => {
      expect(await signupAction({}, form(values))).toEqual({ error });
      expect(await getSessionUserId()).toBeNull();
    },
  );

  it("restores locale and timezone but refuses external redirect destinations", async () => {
    const user = await account({ locale: "zh" });
    await expect(
      loginAction(
        {},
        form({
          email: user.email,
          password,
          detectedTimeZone: "Asia/Tokyo",
          next: "https://evil.invalid",
        }),
      ),
    ).rejects.toThrow("redirect:/app");
    expect(await getSessionUserId()).toBe(user.id);
    expect(browser.values.get("NEXT_LOCALE")).toBe("zh");
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: user.id } }))
        .detectedTimeZone,
    ).toBe("Asia/Tokyo");
    await expect(logoutAction()).rejects.toThrow("redirect:/");
    expect(await getSessionUserId()).toBeNull();
  });

  it("does not authenticate suspended users or wrong passwords", async () => {
    const user = await account({ status: "suspended" });
    expect(
      await loginAction({}, form({ email: user.email, password })),
    ).toEqual({ error: "accountSuspended" });
    expect(
      await loginAction(
        {},
        form({ email: user.email, password: "wrong-password" }),
      ),
    ).toEqual({ error: "invalidCredentials" });
    expect(
      await loginAction(
        {},
        form({ email: `${prefix}-missing@test.invalid`, password }),
      ),
    ).toEqual({ error: "invalidCredentials" });
    expect(await getSessionUserId()).toBeNull();
  });

  it("changes the password atomically, invalidates old sessions and deletes outstanding reset links", async () => {
    const user = await account();
    await expect(
      loginAction({}, form({ email: user.email, password })),
    ).rejects.toThrow("redirect:/app");
    const oldSession = browser.values.get("mcp_session");
    await db.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    expect(
      await changePasswordAction(
        {},
        form({
          currentPassword: password,
          newPassword: "replacement-password-123",
          passwordConfirmation: "replacement-password-123",
        }),
      ),
    ).toEqual({ success: "passwordChanged" });
    const updated = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.sessionVersion).toBe(user.sessionVersion + 1);
    expect(await verifyPassword(password, updated.passwordHash)).toBe(false);
    expect(
      await verifyPassword("replacement-password-123", updated.passwordHash),
    ).toBe(true);
    expect(
      await db.passwordResetToken.count({ where: { userId: user.id } }),
    ).toBe(0);
    expect(await getSessionUserId()).toBe(user.id);
    browser.values.set("mcp_session", String(oldSession));
    expect(await getSessionUserId()).toBeNull();
  });

  it.each([
    [
      {
        currentPassword: "wrong",
        newPassword: "replacement-password",
        passwordConfirmation: "replacement-password",
      },
      "currentPasswordInvalid",
    ],
    [
      {
        currentPassword: password,
        newPassword: password,
        passwordConfirmation: password,
      },
      "passwordMustChange",
    ],
    [
      {
        currentPassword: password,
        newPassword: "replacement-password",
        passwordConfirmation: "different-password",
      },
      "passwordMismatch",
    ],
    [
      {
        currentPassword: password,
        newPassword: "short",
        passwordConfirmation: "short",
      },
      "passwordTooShort",
    ],
    [
      {
        currentPassword: "x".repeat(129),
        newPassword: password,
        passwordConfirmation: password,
      },
      "currentPasswordInvalid",
    ],
    [
      {
        currentPassword: password,
        newPassword: "x".repeat(129),
        passwordConfirmation: "x".repeat(129),
      },
      "passwordTooLong",
    ],
  ])(
    "preserves credentials on rejected password change: %j",
    async (values, error) => {
      const user = await account();
      await expect(
        loginAction({}, form({ email: user.email, password })),
      ).rejects.toThrow("redirect:/app");
      expect(await changePasswordAction({}, form(values))).toEqual({ error });
      const unchanged = await db.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(unchanged.passwordHash).toBe(user.passwordHash);
      expect(unchanged.sessionVersion).toBe(user.sessionVersion);
    },
  );

  it("requires a session for password and API token mutations", async () => {
    expect(await changePasswordAction({}, new FormData())).toEqual({
      error: "signInRequired",
    });
    expect(await createTokenAction({}, form({ name: "test" }))).toEqual({
      error: "You must be signed in.",
    });
  });

  it("creates working API credentials and prevents a different user revoking them", async () => {
    const owner = await account();
    await expect(
      loginAction({}, form({ email: owner.email, password })),
    ).rejects.toThrow("redirect:/app");
    const result = await createTokenAction(
      {},
      form({ name: " local cli ", workspace: "team" }),
    );
    expect((await verifyApiToken(`Bearer ${result.token}`))?.id).toBe(owner.id);
    const token = await db.apiToken.findFirstOrThrow({
      where: { userId: owner.id },
    });
    expect(token.name).toBe("local cli");
    const other = await account();
    await expect(
      loginAction({}, form({ email: other.email, password })),
    ).rejects.toThrow("redirect:/app");
    await revokeTokenAction(form({ id: token.id }));
    expect((await verifyApiToken(`Bearer ${result.token}`))?.id).toBe(owner.id);
    await expect(
      loginAction({}, form({ email: owner.email, password })),
    ).rejects.toThrow("redirect:/app");
    await revokeTokenAction(form({ id: token.id, workspace: "team" }));
    expect(await verifyApiToken(`Bearer ${result.token}`)).toBeNull();
  });

  it.each([
    [
      { token: "invalid", password: "short", passwordConfirmation: "short" },
      "passwordTooShort",
    ],
    [
      { token: "invalid", password, passwordConfirmation: "different" },
      "passwordMismatch",
    ],
    [
      {
        token: "invalid",
        password: "x".repeat(129),
        passwordConfirmation: "x".repeat(129),
      },
      "passwordTooLong",
    ],
    [
      { token: "invalid", password, passwordConfirmation: password },
      "resetLinkInvalid",
    ],
  ])("rejects invalid reset requests: %j", async (values, error) => {
    expect(await resetPasswordAction({}, form(values))).toEqual({ error });
  });
  it("consumes a reset link once and clears the authenticated browser session", async () => {
    const user = await account();
    await expect(
      loginAction({}, form({ email: user.email, password })),
    ).rejects.toThrow("redirect:/app");
    const token = generatePasswordResetToken();
    await db.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashPasswordResetToken(token),
        expiresAt: passwordResetExpiry(),
      },
    });
    const values = form({
      token,
      password: "reset-password-value",
      passwordConfirmation: "reset-password-value",
    });
    expect(await resetPasswordAction({}, values)).toEqual({
      success: "passwordResetComplete",
    });
    expect(await getSessionUserId()).toBeNull();
    expect(await resetPasswordAction({}, values)).toEqual({
      error: "resetLinkInvalid",
    });
    const updated = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(
      await verifyPassword("reset-password-value", updated.passwordHash),
    ).toBe(true);
    expect(updated.sessionVersion).toBe(user.sessionVersion + 1);
  });
  it.each([
    { sub: 42, sv: 0 },
    { sub: "missing-user", sv: 0 },
  ])(
    "rejects correctly signed sessions without an active account identity: %j",
    async (payload) => {
      const token = await new SignJWT(payload as Record<string, unknown>)
        .setProtectedHeader({ alg: "HS256" })
        .setExpirationTime("1h")
        .sign(new TextEncoder().encode(process.env.AUTH_SECRET));
      browser.values.set("mcp_session", token);
      expect(await getSessionUserId()).toBeNull();
    },
  );

  it("rejects tampered and expired session cookies", async () => {
    const user = await account();
    const expired = await new SignJWT({ sub: user.id, sv: user.sessionVersion })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime(1)
      .sign(new TextEncoder().encode(process.env.AUTH_SECRET));
    browser.values.set("mcp_session", expired);
    expect(await getSessionUserId()).toBeNull();
    browser.values.set("mcp_session", "not-a-jwt");
    expect(await getSessionUserId()).toBeNull();
  });
  it("returns the same reset response for existing, unknown and malformed addresses", async () => {
    const user = await account();
    for (const email of [
      user.email,
      `${prefix}-absent@test.invalid`,
      "invalid",
    ]) {
      expect(await forgotPasswordAction({}, form({ email }))).toEqual({
        success: "forgotPasswordSent",
      });
    }
    for (const task of deferred.tasks) await task();
    const token = await db.passwordResetToken.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(token.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(
      await db.passwordResetToken.count({ where: { userId: user.id } }),
    ).toBe(1);
  });
});
