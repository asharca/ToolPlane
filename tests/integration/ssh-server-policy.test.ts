// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { PRIVATE_HOSTS_SETTING_KEY } from "@/lib/admin/settings";
import { resolveSshAddress } from "@/lib/sandboxes/ssh-servers";

const key = PRIVATE_HOSTS_SETTING_KEY;
const allow = (value: string) =>
  db.systemSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });

beforeEach(() => db.systemSetting.deleteMany({ where: { key } }));
afterAll(async () => {
  await db.systemSetting.deleteMany({ where: { key } });
  await db.$disconnect();
});

describe("user-added SSH server addresses", () => {
  it("never reaches the ToolPlane host, link-local or metadata addresses, even when listed", async () => {
    await allow("127.0.0.1,169.254.169.254,localhost");
    for (const host of [
      "127.0.0.1",
      "::1",
      "::ffff:127.0.0.1",
      "0.0.0.0",
      "169.254.169.254",
      "fe80::1",
      "localhost",
      "db.localhost",
    ])
      await expect(resolveSshAddress(host)).rejects.toMatchObject({
        code: "SSH_HOST_FORBIDDEN",
      });
  });

  it("allows public addresses but LAN addresses only when the administrator lists them", async () => {
    await expect(resolveSshAddress("8.8.8.8")).resolves.toBe("8.8.8.8");
    await expect(resolveSshAddress("10.20.0.5")).rejects.toMatchObject({
      code: "SSH_HOST_PRIVATE_NOT_ALLOWED",
    });
    await allow("10.20.0.5");
    await expect(resolveSshAddress("10.20.0.5")).resolves.toBe("10.20.0.5");
    await expect(resolveSshAddress("::ffff:10.20.0.5")).resolves.toBe(
      "10.20.0.5",
    );
    await expect(resolveSshAddress("10.20.0.6")).rejects.toMatchObject({
      code: "SSH_HOST_PRIVATE_NOT_ALLOWED",
    });
    // Removing the entry stops the next connection.
    await db.systemSetting.deleteMany({ where: { key } });
    await expect(resolveSshAddress("10.20.0.5")).rejects.toMatchObject({
      code: "SSH_HOST_PRIVATE_NOT_ALLOWED",
    });
  });
});
