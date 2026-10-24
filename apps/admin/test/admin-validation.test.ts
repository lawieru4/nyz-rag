import assert from "node:assert/strict";
import test from "node:test";
import { validateAdminIdentity, validateAdminPassword } from "../src/admin-validation.ts";

test("identity validation preserves required-field order and error messages", () => {
  const cases = [
    { email: "", nickname: "", error: "请输入邮箱" },
    { email: " \t ", nickname: "Admin", error: "请输入邮箱" },
    { email: "invalid", nickname: "", error: "邮箱格式不正确" },
    { email: "admin@example.com", nickname: " \t ", error: "请输入昵称" },
  ];
  for (const { email, nickname, error } of cases) {
    assert.equal(validateAdminIdentity({ email, nickname }), error);
  }
});

test("identity validation checks trimmed input without mutating form values", () => {
  const identity = Object.freeze({ email: " admin@example.com ", nickname: " Admin " });
  assert.equal(validateAdminIdentity(identity), "");
  assert.deepEqual(identity, { email: " admin@example.com ", nickname: " Admin " });
});

test("identity validation preserves the existing email pattern", () => {
  for (const email of ["a@b", "@example.com", "a b@example.com", "a@@example.com", "a@example. com"]) {
    assert.equal(validateAdminIdentity({ email, nickname: "Admin" }), "邮箱格式不正确", email);
  }
  for (const email of ["a+b@example.com", "a@example.co.uk"]) {
    assert.equal(validateAdminIdentity({ email, nickname: "Admin" }), "", email);
  }
});

test("password validation preserves creation and password-change wording", () => {
  for (const label of ["密码", "新密码"] as const) {
    assert.equal(validateAdminPassword("", label), `请输入${label}`);
    assert.equal(validateAdminPassword("a".repeat(7), label), `${label}至少 8 个字符`);
    assert.equal(validateAdminPassword("a".repeat(1025), label), `${label}不能超过 1024 个字符`);
    assert.equal(validateAdminPassword("a".repeat(8), label), "");
    assert.equal(validateAdminPassword("a".repeat(1024), label), "");
  }
});

test("password validation does not trim passwords or add new strength rules", () => {
  assert.equal(validateAdminPassword(" ".repeat(8), "密码"), "");
  assert.equal(validateAdminPassword(" 123456 ", "新密码"), "");
  assert.equal(validateAdminPassword(" 12345 ", "新密码"), "新密码至少 8 个字符");
});
