import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { encryptSecret } from "../src/secrets.js";
import { checkSecrets, compareMigrations, drillDatabaseName, RESTORE_DRILL_DATABASE, schemaTableNames, TABLE_RECOVERY } from "../src/restore-drill.js";

const KEY = "unit-test-master-key-with-at-least-32-chars";

test("every table in the schema has a recovery class for the backup guide", () => {
  const tables = schemaTableNames();
  assert.ok(tables.includes("documents") && tables.includes("chat_messages"));
  assert.deepEqual(tables.filter((table) => !TABLE_RECOVERY[table]), [], "classify new tables in TABLE_RECOVERY and docs/backup-restore.md");
  assert.deepEqual(Object.keys(TABLE_RECOVERY).filter((table) => !tables.includes(table)), [], "remove dropped tables from TABLE_RECOVERY");
});

test("drill databases have a recognisable name that never matches the business database", () => {
  const name = drillDatabaseName(new Date("2026-10-27T05:26:46.123Z"), "a1b2c3");
  assert.equal(name, "nyzrag_restore_drill_20261027t052646_a1b2c3");
  assert.match(drillDatabaseName(), RESTORE_DRILL_DATABASE);
  for (const other of ["nyzrag", "postgres", "nyzrag_restore_drill_x", `${name}; DROP DATABASE nyzrag`]) assert.doesNotMatch(other, RESTORE_DRILL_DATABASE);
  assert.throws(() => drillDatabaseName(new Date(), "XYZ!"));
});

test("migration check follows drizzle: pending after the last record, missing before it, unknown from newer code", () => {
  const journal = [{ tag: "0000_a", folderMillis: 100 }, { tag: "0001_b", folderMillis: 200 }, { tag: "0002_c", folderMillis: 300 }];
  assert.deepEqual(compareMigrations([100, 200, 300], journal), { applied: 3, pending: [], missing: [], unknown: [] });
  assert.deepEqual(compareMigrations([100], journal), { applied: 1, pending: ["0001_b", "0002_c"], missing: [], unknown: [] });
  assert.deepEqual(compareMigrations([100, 300], journal), { applied: 2, pending: [], missing: ["0001_b"], unknown: [] });
  assert.deepEqual(compareMigrations([100, 200, 300, 400], journal), { applied: 4, pending: [], missing: [], unknown: [400] });
  assert.deepEqual(compareMigrations([], journal), { applied: 0, pending: ["0000_a", "0001_b", "0002_c"], missing: [], unknown: [] });
});

test("the repository journal is strictly ordered, so created_at identifies each migration", async () => {
  const journal = JSON.parse(await readFile(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: { when: number }[] };
  const times = journal.entries.map((entry) => entry.when);
  assert.ok(times.every((time, index) => index === 0 || time > times[index - 1]!));
});

test("secret check reports which ciphertexts the current key opens without returning plaintext", (context) => {
  const previous = process.env.NYZ_SECRET_KEY;
  context.after(() => { if (previous === undefined) delete process.env.NYZ_SECRET_KEY; else process.env.NYZ_SECRET_KEY = previous; });
  process.env.NYZ_SECRET_KEY = KEY;
  const good = { label: "provider", ciphertext: encryptSecret("sk-live", "model-provider:p1"), context: "model-provider:p1" };
  const moved = { label: "moved", ciphertext: good.ciphertext, context: "model-provider:p2" };
  const results = checkSecrets([good, moved]);
  assert.deepEqual(results.map((result) => [result.label, Boolean(result.error)]), [["provider", false], ["moved", true]]);
  assert.doesNotMatch(JSON.stringify(results), /sk-live/);

  process.env.NYZ_SECRET_KEY = `${KEY}-rotated`;
  assert.match(checkSecrets([good])[0]!.error!, /NYZ_SECRET_KEY/);
  delete process.env.NYZ_SECRET_KEY;
  assert.match(checkSecrets([good])[0]!.error!, /未配置 NYZ_SECRET_KEY/);
});
