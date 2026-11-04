// @vitest-environment node
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseRemoteMcpPrivateHosts } from "../../scripts/remote-mcp-private-hosts.mjs";

const client = new Client({ connectionString: process.env.DATABASE_URL });
const shared = "network.privateHosts";
const mcp = "mcp.remotePrivateHosts";
const ssh = "sandboxes.sshPrivateHosts";
const emptyOverrides: Record<string, string>[] = [
  { [mcp]: "" },
  { [ssh]: " \n," },
  { [mcp]: "", [ssh]: "" },
];
let migration: string;

beforeAll(async () => {
  migration = await readFile(
    new URL(
      "../../prisma/migrations/20261105000000_shared_private_hosts/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await client.connect();
  // The migration resolves this session-local table, never the application's
  // actual settings. Its schema and constraints still match the real table.
  await client.query(
    'CREATE TEMP TABLE "SystemSetting" (LIKE public."SystemSetting" INCLUDING ALL)',
  );
});
beforeEach(async () => {
  await client.query('TRUNCATE pg_temp."SystemSetting"');
});
afterAll(() => client.end());

async function seed(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    await client.query(
      'INSERT INTO pg_temp."SystemSetting" ("key", "value", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)',
      [key, value],
    );
  }
}

async function migrate() {
  await client.query(migration);
  const { rows } = await client.query<{ key: string; value: string }>(
    'SELECT "key", "value" FROM pg_temp."SystemSetting" ORDER BY "key"',
  );
  return Object.fromEntries(rows.map(({ key, value }) => [key, value]));
}

describe("shared private host policy data migration", () => {
  it("leaves an unconfigured database unconfigured on repeated execution", async () => {
    expect(await migrate()).toEqual({});
    expect(await migrate()).toEqual({});
  });

  it("unions and deduplicates normalized entries, retires legacy keys and is idempotent", async () => {
    await seed({
      [mcp]: "MCP.EXAMPLE.COM.\n10.20.0.5,*.EXAMPLE.COM",
      [ssh]: "10.20.0.5,ssh.example.com\r\n",
      unrelated: "preserve",
    });
    const expected = {
      [shared]: "*.example.com,10.20.0.5,mcp.example.com,ssh.example.com",
      unrelated: "preserve",
    };
    expect(await migrate()).toEqual(expected);
    expect(await migrate()).toEqual(expected);
  });

  it.each(emptyOverrides)(
    "retains an explicit empty override instead of enabling environment fallback (%s)",
    async (values) => {
      await seed(values);
      expect(await migrate()).toEqual({ [shared]: "" });
      expect(await migrate()).toEqual({ [shared]: "" });
    },
  );

  it("does not let an empty legacy list discard entries from the other list", async () => {
    await seed({ [mcp]: "", [ssh]: "10.20.0.5" });
    expect(await migrate()).toEqual({ [shared]: "10.20.0.5" });
  });

  it.each([mcp, ssh])("migrates a single legacy list (%s)", async (key) => {
    await seed({ [key]: "10.20.0.5" });
    expect(await migrate()).toEqual({ [shared]: "10.20.0.5" });
  });

  it.each(["", "10.20.0.9", "not a valid policy"])(
    "preserves an already saved new value verbatim (%s)",
    async (value) => {
      await seed({ [shared]: value, [mcp]: "10.20.0.5", [ssh]: "10.20.0.6" });
      expect(await migrate()).toEqual({ [shared]: value });
    },
  );

  it.each([
    "10.20.0.5,127.0.0.1",
    "10.20.0.5,".repeat(900),
    Array.from({ length: 101 }, (_, i) => `10.20.0.${i + 1}`).join(","),
  ])(
    "never repairs a corrupt legacy override into a permissive policy",
    async (value) => {
      await seed({ [mcp]: value, [ssh]: "10.20.0.6" });
      const result = await migrate();
      expect(Object.keys(result)).toEqual([shared]);
      expect(parseRemoteMcpPrivateHosts(result[shared])).toBeNull();
    },
  );

  it("rolls back the entire cutover if retiring a legacy row fails", async () => {
    await seed({ [mcp]: "10.20.0.5", [ssh]: "10.20.0.6" });
    await client.query(`
      CREATE OR REPLACE FUNCTION pg_temp.reject_policy_delete() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test retirement failure'; END; $$;
      CREATE TRIGGER reject_policy_delete BEFORE DELETE ON pg_temp."SystemSetting"
      FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_policy_delete();
    `);
    try {
      await expect(migrate()).rejects.toThrow("test retirement failure");
      const { rows } = await client.query(
        'SELECT "key", "value" FROM pg_temp."SystemSetting" ORDER BY "key"',
      );
      expect(rows).toEqual([
        { key: mcp, value: "10.20.0.5" },
        { key: ssh, value: "10.20.0.6" },
      ]);
    } finally {
      await client.query(
        'DROP TRIGGER reject_policy_delete ON pg_temp."SystemSetting"',
      );
    }
  });
});
