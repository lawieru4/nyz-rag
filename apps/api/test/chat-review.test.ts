import assert from "node:assert/strict";
import { mock, test } from "node:test";
import * as processing from "@nyz-rag/processing";
import type { ChatReviewInput } from "@nyz-rag/types";

const id = "00000000-0000-4000-8000-000000000001";
let writes = 0;
let approves = 0;
let exports = 0;
let feedback: unknown[] = [];
let filter: unknown;
let conflict = false;
const candidate = { question: "Public question", history: [], filters: null, type: "unanswerable" as const, split: "dev" as const, answerable: false, labels: [] };
const input: ChatReviewInput = { status: "resolved", reasons: ["outdated"], notes: "PRIVATE_INTERNAL", correctedAnswer: "PRIVATE_CORRECTION", candidate };
mock.module("@nyz-rag/processing", { namedExports: {
  ...processing,
  getChatReview: async () => ({ ...input, revision: 1, approvedRevision: 1, approvedAt: "2026-10-25T00:00:00Z", approvedBy: "PRIVATE_ADMIN", visitorHash: "PRIVATE_VISITOR" }),
  saveChatReview: async () => { writes++; return !conflict; },
  approveChatReview: async () => { approves++; return !conflict; },
  exportChatReview: async () => { exports++; if (conflict) throw new Error("Stale approval"); return { ...processing.exportReviewedCandidate({ ...input, revision: 1, approvedRevision: 1, approvedAt: "2026-10-25T00:00:00Z" }, 1), visitorHash: "PRIVATE_VISITOR" }; },
  rateChatMessage: async (...args: unknown[]) => { feedback = args; return args[0] === id; },
  listChatMessages: async (value: unknown) => { filter = value; return { logs: [], total: 0 }; },
} });
const { adminAuth, adminHeaders, buildTestApp, makeAdminCredential, memoryAdmins, memoryAuthStore, userAuth, memoryUsers, userHeaders } = await import("./auth-helpers.js");
const { hashPassword } = await import("../src/passwords.js");

test("real review handlers enforce manage separately, confirm explicitly, serialize allowlists and report conflicts", async () => {
  const admins = memoryAdmins([makeAdminCredential({ isSuper: false, passwordHash: await hashPassword("test-password-review") })]);
  const account = [...admins.accounts.values()][0];
  const role = await admins.repository.createAdminRole({ name: "Reviewer", description: "", permissions: ["chat-logs:view"] });
  await admins.repository.updateAdminAccount(account.id, { roleId: role.id });
  const app = buildTestApp({ adminAuth, authStore: memoryAuthStore(), admins: admins.repository });
  try {
    const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", headers: adminHeaders, payload: { username: account.email, password: "test-password-review" } });
    assert.equal(login.statusCode, 200, login.body);
    const headers = { ...adminHeaders, cookie: String(login.headers["set-cookie"]).split(";")[0] };
    const base = `/api/admin/chat-logs/${id}/review`;
    const read = await app.inject({ method: "GET", url: base, headers });
    assert.equal(read.statusCode, 200, read.body);
    assert.equal(read.json().candidate.type, "unanswerable");
    assert.doesNotMatch(read.body, /PRIVATE_ADMIN|PRIVATE_VISITOR|approvedBy|visitorHash/);
    for (const [method, suffix, payload] of [["PUT", "", { revision: 1, review: input }], ["POST", "/approve", { revision: 1, confirmSanitized: true }], ["POST", "/export", { revision: 1 }]] as const) {
      const response = await app.inject({ method, url: base + suffix, headers, payload });
      assert.equal(response.statusCode, 403, response.body);
    }
    assert.equal(writes + approves + exports, 0, "denied before repository access");
    await admins.repository.updateAdminRole(role.id, { permissions: ["chat-logs:manage"] });
    for (const review of [{ ...input, approvedRevision: 1 }, { ...input, candidate: { ...candidate, email: "PRIVATE" } }, { ...input, candidate: { ...candidate, history: [{ question: "Q", answer: "A", visitorHash: "PRIVATE" }] } }, { ...input, candidate: { ...candidate, filters: { privateTenant: "PRIVATE" } } }]) {
      const invalid = await app.inject({ method: "PUT", url: base, headers, payload: { revision: 1, review } });
      assert.equal(invalid.statusCode, 400, invalid.body);
    }
    assert.equal(writes, 0, "invalid candidate fields rejected before storage");
    let response = await app.inject({ method: "PUT", url: base, headers, payload: { revision: 1, review: input } });
    assert.equal(response.statusCode, 204, response.body);
    response = await app.inject({ method: "POST", url: base + "/approve", headers, payload: { revision: 1, confirmSanitized: false } });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(approves, 0);
    response = await app.inject({ method: "POST", url: base + "/approve", headers, payload: { revision: 1, confirmSanitized: true } });
    assert.equal(response.statusCode, 204, response.body);
    response = await app.inject({ method: "POST", url: base + "/export", headers, payload: { revision: 1 } });
    assert.equal(response.statusCode, 200, response.body);
    assert.match(String(response.headers["content-disposition"]), /attachment/);
    assert.doesNotMatch(response.body, /PRIVATE|visitorHash|correctedAnswer|notes/);
    assert.equal(response.json().questions[0].type, "unanswerable");
    conflict = true;
    for (const [method, suffix, payload] of [["PUT", "", { revision: 1, review: input }], ["POST", "/approve", { revision: 1, confirmSanitized: true }], ["POST", "/export", { revision: 1 }]] as const) {
      response = await app.inject({ method, url: base + suffix, headers, payload });
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(typeof response.json().error, "string");
    }
    response = await app.inject({ method: "GET", url: "/api/admin/chat-logs?rating=negative&status=investigating", headers });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(filter, { query: "", rating: "negative", status: "investigating", page: 1, pageSize: 20 });
  } finally { await app.close(); }
});

test("feedback handler accepts reversal and reasons, rejects invalid contracts, uses owner boundary", async () => {
  const app = buildTestApp({ userAuth, userAuthStore: memoryAuthStore(), users: memoryUsers().repository, mailer: null });
  try {
    for (const rating of ["positive", "negative", null]) {
      const response = await app.inject({ method: "POST", url: `/api/messages/${id}/feedback`, headers: userHeaders, payload: { rating, reasons: ["citation-mismatch"] } });
      assert.equal(response.statusCode, 204, response.body);
      assert.equal(feedback[1], rating);
      assert.ok(feedback[2], "resolved owner is passed to storage");
      assert.deepEqual(feedback[4], ["citation-mismatch"]);
    }
    for (const payload of [{ rating: "bad" }, { rating: null, reasons: ["bad"] }, { rating: "negative", reasons: "bad" }]) {
      const response = await app.inject({ method: "POST", url: `/api/messages/${id}/feedback`, headers: userHeaders, payload });
      assert.equal(response.statusCode, 400, response.body);
    }
    const response = await app.inject({ method: "POST", url: "/api/messages/00000000-0000-4000-8000-000000000002/feedback", headers: userHeaders, payload: { rating: "negative" } });
    assert.equal(response.statusCode, 404, response.body);
  } finally { await app.close(); }
});
