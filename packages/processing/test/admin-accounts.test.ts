import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { readFile } from "node:fs/promises";
import { closeDatabase, migrate } from "../src/db.js";
import { createAdminAccount, getAdminCredentials, listAdminAccounts, seedSuperAdmin, setAdminDisabled, updateAdminPassword, updateAdminProfile } from "../src/repository.js";

test("migration timestamps strictly increase so existing databases receive new tables", async () => {
  const journal = JSON.parse(await readFile(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8"));
  for (let i = 1; i < journal.entries.length; i++) {
    assert.ok(journal.entries[i].when > journal.entries[i - 1].when, journal.entries[i].tag);
  }
});

test("administrator migration, concurrent bootstrap, uniqueness and session revocation", { skip: process.env.NYZ_INTEGRATION_TEST !== "1", timeout: 30000 }, async () => {
  const previousUrl = process.env.DATABASE_URL;
  const baseUrl = previousUrl ?? "postgresql://nyzrag:nyzrag@localhost:5432/nyzrag";
  const schema = `nyz_admin_test_${randomBytes(6).toString("hex")}`;
  const pool = new pg.Pool({ connectionString: baseUrl });
  await pool.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(baseUrl);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  process.env.DATABASE_URL = url.toString();
  try {
    await migrate();
    const results = await Promise.all(["first", "second"].map(name => seedSuperAdmin({ email: `${name}@example.com`, nickname: name, passwordHash: "test-hash" })));
    assert.equal(results.filter(result => result.created).length, 1);
    assert.equal(results[0]!.id, results[1]!.id);
    const superAdmin = (await listAdminAccounts())[0]!;
    await updateAdminProfile(superAdmin.id, { email: "changed@example.com", nickname: "Changed" });
    await updateAdminPassword(superAdmin.id, "changed-hash");
    await seedSuperAdmin({ email: "first@example.com", nickname: "Reset", passwordHash: "reset-hash" });
    const retained = (await getAdminCredentials({ id: superAdmin.id }))!;
    assert.equal(retained.email, "changed@example.com");
    assert.equal(retained.passwordHash, "changed-hash");
    const regular = (await createAdminAccount({ email: "regular@example.com", nickname: "Regular", passwordHash: "test-hash" }))!;
    assert.equal(regular.isSuper, false);
    assert.equal(await createAdminAccount({ email: regular.email, nickname: "Duplicate", passwordHash: "test-hash" }), null);
    assert.equal(await updateAdminProfile(regular.id, { email: retained.email, nickname: "Duplicate" }), null);
    await setAdminDisabled(regular.id, true);
    assert.equal((await getAdminCredentials({ id: regular.id }))!.sessionVersion, 1);
    await setAdminDisabled(regular.id, false);
    assert.equal((await getAdminCredentials({ id: regular.id }))!.sessionVersion, 1);
    await assert.rejects(setAdminDisabled(superAdmin.id, true), /super admin/);
    assert.equal(Object.hasOwn((await listAdminAccounts())[0]!, "passwordHash"), false);
  } finally {
    await closeDatabase();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  }
});
