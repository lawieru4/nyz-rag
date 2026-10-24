import assert from "node:assert/strict";
import test from "node:test";
import { auditActionLabel, auditOperator, auditResultLabel } from "../src/views/audit-logs.ts";

test("audit actions are labelled by method and route pattern", () => {
  assert.equal(auditActionLabel({ method: "PUT", route: "/api/admin/model-settings/:capability" }), "设置业务模型");
  assert.equal(auditActionLabel({ method: "POST", route: "/api/admin/auth/login" }), "登录");
  // 被拒绝的读取按模块显示，未知路由原样显示。
  assert.equal(auditActionLabel({ method: "GET", route: "/api/admin/model-providers/:id/models" }), "查看模型供应商");
  assert.equal(auditActionLabel({ method: "GET", route: "/api/admin/audit-logs" }), "查看操作日志");
  assert.equal(auditActionLabel({ method: "POST", route: "/api/admin/unknown" }), "POST /api/admin/unknown");
});

test("audit operator and result labels", () => {
  assert.equal(auditOperator({ adminId: null, adminNickname: null }), "未登录");
  assert.equal(auditOperator({ adminId: "a", adminNickname: "管理员" }), "管理员");
  assert.equal(auditResultLabel("denied"), "拒绝");
});
