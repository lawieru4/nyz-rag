import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { KnowledgeOverview } from "@nyz-rag/types";
import { overviewHub } from "../src/knowledge-events.js";
import { hashPassword } from "../src/passwords.js";
import { adminAuth, adminHeaders, buildTestApp, memoryAdmins, memoryAuthStore } from "./auth-helpers.js";

const queue = {
  hasDocumentJob: async () => false, hasSourceJob: async () => false,
  enqueueDocument: async () => {}, enqueueSource: async () => {}, close: async () => {},
};
const overview = (documents: number): KnowledgeOverview => ({ sources: [], tasks: [], stats: { documents, sources: 0, processingTasks: 0, lastUpdated: null } });

test("overview hub shares one poll, pushes only changes and stops without subscribers", async () => {
  let loads = 0;
  let documents = 1;
  const hub = overviewHub(async () => { loads += 1; return overview(documents); }, 10, (error) => { throw error; });
  const first: string[] = [];
  const second: string[] = [];
  const stopFirst = hub.subscribe((payload) => first.push(payload));
  await delay(5);
  const stopSecond = hub.subscribe((payload) => second.push(payload));
  assert.equal(second.length, 1, "a late subscriber receives the latest overview immediately");
  await delay(40);
  assert.equal(first.length, 1, "unchanged overviews are not pushed again");
  documents = 2;
  await delay(30);
  assert.deepEqual([first.length, second.length], [2, 2]);
  assert.equal(JSON.parse(first[1]!).stats.documents, 2);

  stopFirst();
  stopSecond();
  const stoppedAt = loads;
  await delay(40);
  assert.ok(loads <= stoppedAt + 1, "polling stops when the last subscriber leaves");
});

test("GET /api/admin/knowledge/events requires a session, streams overview changes and closes with the app", async () => {
  const email = "admin@example.com";
  const password = "test-only-password-not-for-deployment";
  const now = new Date().toISOString();
  const { repository } = memoryAdmins([{
    id: randomUUID(), email, nickname: "admin", passwordHash: await hashPassword(password),
    isSuper: true, sessionVersion: 0, disabled: false, createdAt: now, updatedAt: now,
  }]);
  let documents = 1;
  const app = buildTestApp({
    queue, adminAuth, authStore: memoryAuthStore(), admins: repository,
    overviewEvents: { load: async () => overview(documents), intervalMs: 10 },
  });
  try {
    const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", headers: adminHeaders, payload: { username: email, password } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const base = await app.listen({ port: 0, host: "127.0.0.1" });

    assert.equal((await fetch(`${base}/api/admin/knowledge/events`)).status, 401);

    const response = await fetch(`${base}/api/admin/knowledge/events`, { headers: { cookie } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    const events = () => [...received.matchAll(/event: overview\ndata: (.+)\n\n/g)].map((match) => JSON.parse(match[1]!) as KnowledgeOverview);
    while (events().length < 1) received += decoder.decode((await reader.read()).value);
    documents = 2;
    while (events().length < 2) received += decoder.decode((await reader.read()).value);
    assert.deepEqual(events().map((event) => event.stats.documents), [1, 2]);

    // 连接未断开时关闭服务也应立即完成。
    await Promise.race([app.close(), delay(2000).then(() => assert.fail("app.close() waited for the event stream"))]);
  } finally {
    await app.close();
  }
});
