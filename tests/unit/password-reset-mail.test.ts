// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  passwordResetEmailConfigured,
  passwordResetUrl,
  sendPasswordResetEmail,
} from "@/lib/auth/password-reset-mail";

const mail = vi.hoisted(() => ({ send: vi.fn().mockResolvedValue(undefined) }));
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: mail.send }) },
}));
afterEach(() => {
  vi.unstubAllEnvs();
  mail.send.mockClear();
});

describe("password reset email", () => {
  it("builds a same-origin reset URL with an encoded token, discarding configured path and query", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://console.example/base?old=value");
    const url = new URL(passwordResetUrl("a+b/&?=token"));
    expect(url.origin).toBe("https://console.example");
    expect(url.pathname).toBe("/app/reset-password");
    expect([...url.searchParams]).toEqual([["token", "a+b/&?=token"]]);
  });

  it.each(["", "file:///tmp/app", "ftp://example.com"])(
    "refuses an unsafe or missing public URL: %s",
    (origin) => {
      vi.stubEnv("NEXT_PUBLIC_APP_URL", origin);
      expect(() => passwordResetUrl("secret")).toThrow();
    },
  );

  it.each([
    ["", "sender@example.com"],
    ["smtp://localhost", "  "],
  ])(
    "does not send when SMTP configuration is incomplete",
    async (smtp, sender) => {
      vi.stubEnv("SMTP_URL", smtp);
      vi.stubEnv("SMTP_FROM", sender);
      expect(passwordResetEmailConfigured()).toBe(false);
      await expect(
        sendPasswordResetEmail({ to: "user@example.com", token: "secret" }),
      ).rejects.toThrow("not configured");
      expect(mail.send).not.toHaveBeenCalled();
    },
  );

  it.each(["zh-CN", "ZH-tw", "en", null])(
    "sends the recipient a localized reset link: %s",
    async (locale) => {
      vi.stubEnv("SMTP_URL", " smtp://localhost ");
      vi.stubEnv("SMTP_FROM", " ToolPlane <sender@example.com> ");
      vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://console.example");
      expect(passwordResetEmailConfigured()).toBe(true);
      await sendPasswordResetEmail({
        to: "user@example.com",
        token: "reset-secret",
        locale,
      });
      expect(mail.send).toHaveBeenCalledWith({
        from: "ToolPlane <sender@example.com>",
        to: "user@example.com",
        subject: locale?.toLowerCase().startsWith("zh")
          ? "重置您的 ToolPlane 密码"
          : "Reset your ToolPlane password",
        text: expect.stringContaining(
          "https://console.example/app/reset-password?token=reset-secret",
        ),
      });
    },
  );

  it("propagates delivery failure rather than reporting a sent email", async () => {
    vi.stubEnv("SMTP_URL", "smtp://localhost");
    vi.stubEnv("SMTP_FROM", "sender@example.com");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://console.example");
    mail.send.mockRejectedValueOnce(new Error("SMTP unavailable"));
    await expect(
      sendPasswordResetEmail({ to: "user@example.com", token: "secret" }),
    ).rejects.toThrow("SMTP unavailable");
  });
});
