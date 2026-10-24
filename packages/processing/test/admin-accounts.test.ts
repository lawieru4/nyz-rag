import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { readFile } from "node:fs/promises";
import { closeDatabase, migrate } from "../src/db.js";
import {
  AdminAccountError, createAdminAccount, createAdminRole, deleteAdminRole, getAdminCredentials, getAdminRole, listAdminAccounts, listAdminRoles, seedSuperAdmin,
  updateAdminAccount, updateAdminPassword, updateAdminProfile, updateAdminRole,
} from "../src/repository.js";
import { ADMIN_PERMISSIONS } from "../src/admin-permissions.js";

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
    await updateAdminAccount(regular.id, { disabled: true });
    assert.equal((await getAdminCredentials({ id: regular.id }))!.sessionVersion, 1);
    await updateAdminAccount(regular.id, { disabled: false });
    assert.equal((await getAdminCredentials({ id: regular.id }))!.sessionVersion, 1);
    await assert.rejects(updateAdminAccount(superAdmin.id, { disabled: true }), (error: unknown) => error instanceof AdminAccountError && error.reason === "super-admin-disable");
    assert.equal(Object.hasOwn((await listAdminAccounts())[0]!, "passwordHash"), false);
  } finally {
    await closeDatabase();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  }
});

test("admin roles: permissions, disable, delete restriction and upgrade backfill", { skip: process.env.NYZ_INTEGRATION_TEST !== "1", timeout: 30000 }, async () => {
  const previousUrl = process.env.DATABASE_URL;
  const baseUrl = previousUrl ?? "postgresql://nyzrag:nyzrag@localhost:5432/nyzrag";
  const schema = `nyz_role_test_${randomBytes(6).toString("hex")}`;
  const pool = new pg.Pool({ connectionString: baseUrl });
  await pool.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(baseUrl);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  process.env.DATABASE_URL = url.toString();
  const isReason = (reason: string) => (error: unknown) => error instanceof AdminAccountError && error.reason === reason;
  try {
    await migrate();
    // 升级回填：模拟升级前已有的普通管理员（role_id 为空），执行 0018 的数据迁移语句。
    await seedSuperAdmin({ email: "super@example.com", nickname: "Super", passwordHash: "test-hash" });
    const legacy = (await createAdminAccount({ email: "legacy@example.com", nickname: "Legacy", passwordHash: "test-hash" }))!;
    const migration = await readFile(new URL("../migrations/0018_admin_roles.sql", import.meta.url), "utf8");
    const backfill = migration.split("--> statement-breakpoint").at(-1)!;
    const client = await pool.connect();
    try { await client.query(`SET search_path TO ${schema}`); await client.query(backfill); } finally { client.release(); }
    const migrated = (await getAdminCredentials({ id: legacy.id }))!;
    assert.equal(migrated.roleName, "普通管理员");
    assert.ok(migrated.permissions.includes("documents:manage") && !migrated.permissions.includes("sources:manage") && !migrated.permissions.includes("models:manage"));
    assert.equal((await getAdminCredentials({ email: "super@example.com" }))!.roleId, null);

    // 管理包含查看；未知权限码在读取时被过滤。
    const role = await createAdminRole({ name: "编辑", description: "", permissions: ["documents:manage", "chat-logs:view"] });
    assert.deepEqual(role.permissions, ["documents:view", "documents:manage", "chat-logs:view"]);
    await assert.rejects(createAdminRole({ name: "编辑", description: "", permissions: [] }), isReason("role-name-taken"));
    await pool.query(`UPDATE ${schema}.admin_roles SET permissions = permissions || '{removed:view}' WHERE id = $1`, [role.id]);
    assert.deepEqual((await getAdminRole(role.id))!.permissions, role.permissions);

    const editor = (await createAdminAccount({ email: "editor@example.com", nickname: "Editor", passwordHash: "test-hash", roleId: role.id }))!;
    assert.equal(editor.roleName, "编辑");
    assert.deepEqual((await getAdminCredentials({ id: editor.id }))!.permissions, role.permissions);
    await assert.rejects(createAdminAccount({ email: "x@example.com", nickname: "X", passwordHash: "h", roleId: "00000000-0000-4000-8000-000000000000" }), isReason("role-missing"));
    const superAdmin = (await getAdminCredentials({ email: "super@example.com" }))!;
    assert.deepEqual(superAdmin.permissions, [...ADMIN_PERMISSIONS]);
    await assert.rejects(updateAdminAccount(superAdmin.id, { roleId: role.id }), isReason("super-admin-role"));

    // 停用角色即收回权限，但不使会话失效；启用后恢复。
    await updateAdminRole(role.id, { disabled: true });
    const disabled = (await getAdminCredentials({ id: editor.id }))!;
    assert.deepEqual(disabled.permissions, []);
    assert.equal(disabled.sessionVersion, 0);
    await updateAdminRole(role.id, { disabled: false, name: "文档编辑", permissions: ["users:view"] });
    assert.deepEqual((await getAdminCredentials({ id: editor.id }))!.permissions, ["users:view"]);
    assert.equal(await updateAdminRole("00000000-0000-4000-8000-000000000000", { name: "x" }), null);
    await assert.rejects(updateAdminRole(role.id, { name: "普通管理员" }), isReason("role-name-taken"));

    // 有管理员使用时不能删除；解除后可删除。
    assert.equal((await listAdminRoles()).find((item) => item.id === role.id)!.adminCount, 1);
    await assert.rejects(deleteAdminRole(role.id), isReason("role-in-use"));
    const unassigned = (await updateAdminAccount(editor.id, { roleId: null }))!;
    assert.equal(unassigned.roleId, null);
    assert.equal(unassigned.roleName, null);
    assert.equal(await deleteAdminRole(role.id), true);
    assert.equal(await deleteAdminRole(role.id), false);
  } finally {
    await closeDatabase();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  }
});
