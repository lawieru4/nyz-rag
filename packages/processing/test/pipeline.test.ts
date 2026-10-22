import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import pg from "pg";
import { closeDatabase, getPool, migrate, withTransaction } from "../src/db.js";
import { createModelProvider, createSource, getDocumentSummary, replaceDocumentChunks, upsertDocument } from "../src/repository.js";

test("API + queue + worker persist vectors, retry failures and clean stale rows", { skip: process.env.NYZ_INTEGRATION_TEST !== "1", timeout: 60000 }, async () => {
  // 每次运行使用独立 schema（search_path 指向它，pgvector 类型仍从 public 解析），结束后整体删除。
  const baseUrl = process.env.DATABASE_URL ?? "postgresql://nyzrag:nyzrag@localhost:5432/nyzrag";
  const schema = `nyz_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Pool({ connectionString: baseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const testUrl = new URL(baseUrl);
  testUrl.searchParams.set("options", `-c search_path=${schema},public`);
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = testUrl.toString();

  let mode: "ok" | "failure" | "slow" = "ok";
  let requested = 0;
  const chatPrompts: string[] = [];
  const chatRequests: Array<Array<{ role: string; content: string }>> = [];
  let chatAborted = false;
  // 模拟 nyzdata 文章接口：两篇文章，第二篇的标题与 updateTime 可在测试中修改。
  const articleToken = "integration-article-token";
  const article = (key: string, title: string, updateTime: number) => ({
    _key: key, title, updateTime, createTime: 1, summary: "摘要", tagName: "科研", tagArray: [{ name: "钠电" }], creator: { nickName: "作者" },
    content: JSON.stringify({ type: "doc", content: [
      { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "作者：qwen3.6-plus" }, { type: "hardBreak" }, { type: "text", text: "转载源：测试公众号" }, { type: "hardBreak" }, { type: "text", text: "关键词：[[钠离子电池]]" }] }] },
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "【结论】" }] },
      { type: "paragraph", content: [{ type: "text", text: `${title}的正文结论。` }] },
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "延伸思考" }] },
      { type: "paragraph", content: [{ type: "text", text: "1. 如何放大？" }] },
    ] }),
  });
  const articles = new Map([["a1", article("a1", "文章一", 100)], ["a2", article("a2", "文章二", 100)]]);
  const articleRequests: string[] = [];
  // 模拟网页站点（同一路径、按 id 区分的页面）：2 声明自身为 canonical；3 与 1 正文相同（排版不同）；4 是 2 的别名地址。
  const siteBody = (topic: string) => `${topic}正极材料的研究进展与产业化前景。`.repeat(4);
  const sitePages: Record<string, { head?: string; body: string; links?: string[] }> = {
    "1": { body: siteBody("钠离子电池"), links: ["page?utm_source=feed&id=2", "page?id=1#top", "page?id=3", "page?id=4"] },
    "2": { head: '<link rel="canonical" href="/site/page?id=2">', body: siteBody("固态电池") },
    "3": { body: siteBody("钠离子电池").replace(/。/g, "。<br>") },
    "4": { head: '<link rel="canonical" href="/site/page?id=2&amp;utm_medium=x">', body: siteBody("固态电池") },
  };
  const siteRequests: string[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://mock");
    if (url.pathname === "/site/page") {
      siteRequests.push(url.search);
      const page = sitePages[url.searchParams.get("id") ?? ""];
      if (!page) { response.writeHead(404).end(); return; }
      response.setHeader("content-type", "text/html; charset=utf-8");
      const links = (page.links ?? []).map((href) => `<a href="${href}">link</a>`).join("");
      response.end(`<html><head><title>页面 ${url.searchParams.get("id")}</title>${page.head ?? ""}</head><body><main>${page.body}</main><nav>${links}</nav></body></html>`);
      return;
    }
    if (url.pathname.startsWith("/nyz/")) {
      articleRequests.push(url.pathname);
      assert.equal(url.searchParams.get("token"), articleToken);
      response.setHeader("content-type", "application/json");
      if (url.pathname === "/nyz/article") {
        const list = url.searchParams.get("curPage") === "1" ? [...articles.values()].map(({ _key, updateTime }) => ({ _key, updateTime })) : [];
        response.end(JSON.stringify({ status: 200, data: { list, total: list.length } }));
      } else {
        response.end(JSON.stringify({ status: 200, data: articles.get(url.searchParams.get("articleKey") ?? "") }));
      }
      return;
    }
    if (request.url !== "/v1/embeddings" && request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
    assert.equal(request.headers.authorization, "Bearer integration-test-key");
    let body = "";
    for await (const chunk of request) body += chunk;
    if (request.url === "/v1/chat/completions") {
      // 模拟流式 Chat：回答引用参考资料中的第一篇文章。
      const { messages, stream } = JSON.parse(body) as { messages: Array<{ role: string; content: string }>; stream: boolean };
      assert.equal(stream, true);
      chatRequests.push(messages);
      chatPrompts.push(messages.at(-1)!.content);
      const title = messages.at(-1)!.content.match(/《(.+?)》/)?.[1] ?? "";
      response.setHeader("content-type", "text/event-stream");
      if (messages.at(-1)!.content.endsWith("问题：slow question")) {
        // 输出第一段后挂起，等待 API 在客户端断开时中止请求。
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "部分" } }] })}\n\n`);
        await once(response, "close");
        chatAborted = true;
        return;
      }
      for (const text of ["根据", `《${title}》[1]。`]) response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      response.end(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`);
      return;
    }
    const { input } = JSON.parse(body) as { input: string[] };
    requested += 1;
    if (mode === "failure") { response.writeHead(503).end("do-not-leak-provider-body"); return; }
    if (mode === "slow") await delay(500);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [index + 1, 0.5, 0.25] })).reverse() }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const mockPort = (server.address() as { port: number }).port;
  const portServer = createServer();
  portServer.listen(0, "127.0.0.1");
  await once(portServer, "listening");
  const apiPort = (portServer.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => portServer.close((error) => error ? reject(error) : resolve()));
  const apiBase = `http://127.0.0.1:${apiPort}`;
  const adminPassword = randomBytes(24).toString("hex");
  let adminCookie = "";
  // 用户端请求像浏览器一样保存访客/账号 Cookie；每个 browser() 是一个独立的浏览器。
  const browser = () => {
    const jar = new Map<string, string>();
    return async (url: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("x-nyz-client", "1");
      if (jar.size) headers.set("cookie", [...jar].map(([name, value]) => `${name}=${value}`).join("; "));
      const response = await globalThis.fetch(url, { ...init, headers });
      for (const line of response.headers.getSetCookie()) {
        const [name, value] = line.split(";")[0]!.split("=") as [string, string];
        if (/Max-Age=0\b/.test(line)) jar.delete(name); else jar.set(name, value);
      }
      return response;
    };
  };
  const visitorFetch = browser();
  const fetch = (url: string, init: RequestInit = {}) => {
    if (!url.startsWith(`${apiBase}/api/admin/`)) return visitorFetch(url, init);
    const headers = new Headers(init.headers);
    headers.set("x-nyz-admin", "1");
    if (adminCookie) headers.set("cookie", adminCookie);
    return globalThis.fetch(url, { ...init, headers });
  };
  let output = "";
  const children: ChildProcess[] = [];
  const start = (entry: string) => {
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), entry], {
      cwd: new URL("../../../", import.meta.url),
      env: {
        ...process.env, API_PORT: String(apiPort), DATABASE_URL: testUrl.toString(), TEST_EMBEDDING_KEY: "integration-test-key", DOCUMENT_QUEUE_NAME: `test-${schema}`,
        NYZ_ARTICLE_TOKEN: articleToken, CRAWL_REQUEST_DELAY_MS: "1000",
        ADMIN_USERNAME: "admin", ADMIN_PASSWORD: adminPassword, ADMIN_COOKIE_SECURE: "false",
        // 不发送真实邮件：开发模式下验证码写入 API 日志，由测试从输出中读取。
        SMTP_HOST: "", USER_COOKIE_SECURE: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => { output += chunk; });
    child.stderr?.on("data", (chunk) => { output += chunk; });
    children.push(child);
  };
  async function until(check: () => Promise<boolean>) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await check()) return;
      if (children.some((child) => child.exitCode !== null)) assert.fail(`Child exited: ${output}`);
      await delay(50);
    }
    assert.fail(`Timed out: ${output}`);
  }
  let documentId = "";
  const embedding = async () => (await getDocumentSummary(documentId))?.embedding;
  async function waitEmbedding(status: string) {
    await until(async () => (await embedding())?.status === status);
    // Status is persisted just before BullMQ removes the completed/failed job.
    await delay(100);
  }
  const embeddedChunks = async () => (await getPool().query("SELECT chunk_index, embedding::text, dimensions FROM document_chunks WHERE document_id = $1 AND embedding IS NOT NULL ORDER BY chunk_index", [documentId])).rows;
  const post = (path: string) => fetch(`${apiBase}/api/admin/documents/${documentId}/${path}`, { method: "POST" });
  try {
    await migrate();
    const source = await createSource({ name: "Test source", url: "https://example.test", kind: "网页站点", frequency: "" });
    documentId = await withTransaction(async (client) => {
      const id = await upsertDocument(client, { sourceId: source.id, url: "https://example.test/a", title: "Vector test", content: "First chunk. Second chunk.", status: "ready" });
      await replaceDocumentChunks(client, id, { content: "First chunk. Second chunk." }, [
        { id: `${id}-1`, index: 0, content: "First chunk.", tokenEstimate: 5 },
        { id: `${id}-2`, index: 1, content: "Second chunk.", tokenEstimate: 5 },
      ]);
      return id;
    });
    await createModelProvider({ name: "Local test", provider: "OpenAI 兼容", baseUrl: `http://127.0.0.1:${mockPort}/v1`, embeddingModel: "test-embedding", chatModel: "test-chat", rerankModel: "", credentialEnv: "TEST_EMBEDDING_KEY", enabled: true, isDefault: true });
    // 模拟升级前已切片的数据：Worker 启动时应补齐关键词检索词项。
    await getPool().query("UPDATE document_chunks SET search_vector = ''::tsvector WHERE document_id = $1", [documentId]);
    start("apps/api/src/index.ts");
    start("apps/worker/src/index.ts");
    await until(async () => { try { return (await fetch(`${apiBase}/health`)).ok; } catch { return false; } });
    assert.equal((await fetch(`${apiBase}/api/admin/documents`)).status, 401);
    const login = await fetch(`${apiBase}/api/admin/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: adminPassword }),
    });
    assert.equal(login.status, 200);
    adminCookie = login.headers.get("set-cookie")!.split(";")[0]!;
    await until(async () => (await getPool().query("SELECT 1 FROM document_chunks WHERE document_id = $1 AND search_vector <> ''::tsvector", [documentId])).rowCount === 2);

    // Exercise the extracted configuration domains through their real request/response schemas.
    const jsonHeaders = { "content-type": "application/json" };
    const knowledgeInput = { name: " Test knowledge ", description: "test", topK: 5, similarityThreshold: 0.3, rerankEnabled: false, maxContextLength: 6000, prompt: "", model: "" };
    const knowledgeCreated = await fetch(`${apiBase}/api/admin/knowledge-bases`, { method: "POST", headers: jsonHeaders, body: JSON.stringify(knowledgeInput) });
    assert.equal(knowledgeCreated.status, 201);
    const knowledge = await knowledgeCreated.json();
    assert.equal(knowledge.name, "Test knowledge");
    assert.equal(knowledge.rerankEnabled, false);
    const knowledgeUpdated = await fetch(`${apiBase}/api/admin/knowledge-bases/${knowledge.id}`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ ...knowledgeInput, description: "updated" }) });
    assert.equal(knowledgeUpdated.status, 200);
    assert.equal((await knowledgeUpdated.json()).description, "updated");
    assert.equal((await (await fetch(`${apiBase}/api/admin/knowledge-bases`)).json()).length, 1);
    const providerInput = { name: "Disabled provider", provider: "OpenAI 兼容", baseUrl: "", chatModel: "test", embeddingModel: "", rerankModel: "", credentialEnv: "UNUSED_KEY", enabled: false, isDefault: false };
    const providerCreated = await fetch(`${apiBase}/api/admin/model-providers`, { method: "POST", headers: jsonHeaders, body: JSON.stringify(providerInput) });
    assert.equal(providerCreated.status, 201);
    const provider = await providerCreated.json();
    assert.equal(provider.temperature, 0.3);
    assert.equal(provider.maxTokens, 1024);
    const providerUpdated = await fetch(`${apiBase}/api/admin/model-providers/${provider.id}`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ ...providerInput, temperature: 0.7, maxTokens: 512 }) });
    assert.equal(providerUpdated.status, 200);
    assert.equal((await providerUpdated.json()).temperature, 0.7);
    assert.equal((await (await fetch(`${apiBase}/api/admin/model-providers`)).json()).length, 2);
    assert.equal((await fetch(`${apiBase}/api/admin/model-providers/${provider.id}`, { method: "DELETE" })).status, 204);

    assert.equal((await post("embed")).status, 202);
    await waitEmbedding("ready");
    let rows = await embeddedChunks();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].embedding, "[1,0.5,0.25]");
    assert.equal(rows[0].dimensions, 3);
    assert.equal((await embedding())?.chunkCount, 2);

    mode = "failure";
    assert.equal((await post("embed")).status, 202);
    await waitEmbedding("failed");
    assert.doesNotMatch((await embedding())?.error ?? "", /do-not-leak-provider-body|integration-test-key/);
    assert.equal((await embeddedChunks()).length, 2, "failed embedding preserves previous vectors");

    mode = "slow";
    assert.equal((await post("embed")).status, 202);
    await until(async () => (await embedding())?.status === "processing");
    assert.equal((await post("embed")).status, 409);
    assert.equal((await fetch(`${apiBase}/api/admin/documents/${documentId}`, { method: "DELETE" })).status, 409);
    // 模拟模型调用期间文档被重新切片：回写必须被拒绝。
    await getPool().query("UPDATE documents SET processing_version = processing_version + 1 WHERE id = $1", [documentId]);
    await waitEmbedding("failed");
    assert.match((await embedding())?.error ?? "", /changed during embedding/);

    mode = "ok";
    assert.equal((await post("reprocess")).status, 202);
    await waitEmbedding("ready");
    rows = await embeddedChunks();
    assert.equal(rows.length, 1, "reprocessing removes obsolete chunk vectors");
    assert.equal((await getPool().query("SELECT summary_embedding FROM documents WHERE id = $1", [documentId])).rows[0].summary_embedding, null, "web pages have no summary vector");

    const chat = await (await fetch(`${apiBase}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "vector test" }) })).json();
    assert.equal(chat.answerMode, "generated", output);
    assert.equal(chat.answer, "根据《Vector test》[1]。");
    assert.equal(chat.sources[0].documentId, documentId);
    assert.match(chatPrompts[0], /\[1\] 《Vector test》\nFirst chunk\. Second chunk\.\n\n问题：vector test$/);
    const search = await (await fetch(`${apiBase}/api/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "Second chunk" }) })).json();
    assert.equal(search.results[0].documentId, documentId);
    assert.equal((await fetch(`${apiBase}/api/messages/${chat.messageId}/feedback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rating: "positive" }) })).status, 204);
    const logs = await (await fetch(`${apiBase}/api/admin/chat-logs?rating=rated&query=vector`)).json();
    assert.equal(logs.total, 1);
    assert.deepEqual(logs.logs[0].sources, chat.sources);
    assert.equal(logs.logs[0].model, "test-chat");
    assert.equal(logs.logs[0].promptTokens, 20);
    assert.equal(typeof logs.logs[0].retrievalMs, "number");
    assert.equal(logs.logs[0].chunks.length, 1);
    assert.equal(logs.logs[0].chunks[0].vectorScore, 1, "the query vector matches the stored chunk vector");
    assert.ok(logs.logs[0].chunks[0].keywordScore > 0);

    // 会话与 SSE 流式问答：source → token → done；追问带上历史；重新生成只能针对最后一轮，被替换的回答保留在问答记录中。
    async function stream(sessionId: string, body: object) {
      const response = await fetch(`${apiBase}/api/chat/sessions/${sessionId}/stream`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
      return (await response.text()).split("\n\n").filter((block) => block.startsWith("event: ")).map((block) => {
        const [event, data] = block.split("\n");
        return { event: event.slice("event: ".length), data: JSON.parse(data.slice("data: ".length)) };
      });
    }
    const created = await fetch(`${apiBase}/api/chat/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(created.status, 201);
    const session = await created.json();
    const first = await stream(session.id, { question: "vector test" });
    assert.deepEqual(first.map((item) => item.event), ["source", "token", "token", "done"]);
    assert.deepEqual(first[0].data, { ...chat.sources[0], citation: 1 });
    assert.equal(first[1].data.content, "根据");
    assert.equal(first[3].data.answer, "根据《Vector test》[1]。");
    const second = await stream(session.id, { question: "它的第二段呢？" });
    assert.equal(second.at(-1)!.event, "done");
    assert.deepEqual(chatRequests.at(-1)!.slice(1, 3), [{ role: "user", content: "vector test" }, { role: "assistant", content: "根据《Vector test》。" }]);
    const regenerated = await stream(session.id, { regenerate: second.at(-1)!.data.id });
    assert.equal(regenerated.at(-1)!.data.question, "它的第二段呢？");
    assert.equal(chatRequests.at(-1)!.length, 4, "regeneration excludes the replaced turn from the history");
    const regenerateFirst = await fetch(`${apiBase}/api/chat/sessions/${session.id}/stream`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ regenerate: first[3].data.id }) });
    assert.equal(regenerateFirst.status, 409);
    const sessionMessages = await (await fetch(`${apiBase}/api/chat/sessions/${session.id}/messages`)).json();
    assert.deepEqual(sessionMessages.messages.map((message: { id: string }) => message.id), [first[3].data.id, regenerated.at(-1)!.data.id]);
    assert.equal(sessionMessages.session.title, "vector test");
    const sessions = await (await fetch(`${apiBase}/api/chat/sessions`)).json();
    assert.deepEqual([sessions.total, sessions.sessions[0].messageCount], [1, 2]);
    const followUpLogs = await (await fetch(`${apiBase}/api/admin/chat-logs?query=${encodeURIComponent("第二段")}`)).json();
    assert.deepEqual(followUpLogs.logs.map((log: { sessionId: string; supersededAt?: string }) => [log.sessionId, Boolean(log.supersededAt)]), [[session.id, false], [session.id, true]]);
    assert.deepEqual(followUpLogs.logs.map((log: { ownerType: string }) => log.ownerType), ["visitor", "visitor"]);

    // 访问隔离：另一个浏览器看不到、改不了这个访客的会话与问答。
    const stranger = browser();
    assert.deepEqual(await (await stranger(`${apiBase}/api/chat/sessions`)).json(), { sessions: [], total: 0 });
    assert.equal((await stranger(`${apiBase}/api/chat/sessions/${session.id}/messages`)).status, 404);
    assert.equal((await stranger(`${apiBase}/api/chat/sessions/${session.id}/stream`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ question: "x" }) })).status, 404);
    assert.equal((await stranger(`${apiBase}/api/chat/sessions/${session.id}`, { method: "DELETE" })).status, 404);
    assert.equal((await stranger(`${apiBase}/api/messages/${chat.messageId}/feedback`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ rating: "negative" }) })).status, 404);
    assert.equal((await fetch(`${apiBase}/api/chat/sessions/${session.id}/messages`)).status, 200, "the owner still has access");
    // 历史数据（无归属）对任何用户都不可见。
    const { rows: [legacy] } = await getPool().query("INSERT INTO chat_sessions (id, title) VALUES (gen_random_uuid()::text, 'legacy') RETURNING id");
    assert.equal((await fetch(`${apiBase}/api/chat/sessions/${legacy.id}/messages`)).status, 404);

    // 邮箱注册：本浏览器的访客会话与问答归入账号；退出后看不到，重新登录后恢复。
    const email = `reader-${schema}@example.com`;
    const userPassword = "integration password";
    const mailCode = async () => {
      await until(async () => output.includes(email) && /验证码为 \d{6}/.test(output.slice(output.lastIndexOf(email))));
      return output.slice(output.lastIndexOf(email)).match(/验证码为 (\d{6})/)![1]!;
    };
    assert.equal((await fetch(`${apiBase}/api/auth/register/code`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ email }) })).status, 204);
    const registered = await fetch(`${apiBase}/api/auth/register`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ email, code: await mailCode(), password: userPassword }) });
    assert.equal(registered.status, 201);
    const account = (await registered.json()).user;
    const owners = await getPool().query("SELECT user_id, visitor_hash FROM chat_messages WHERE id = $1 OR session_id = $2", [chat.messageId, session.id]);
    assert.ok(owners.rows.length >= 4 && owners.rows.every((row) => row.user_id === account.id && row.visitor_hash === null), "visitor data moves to the account");
    assert.equal((await (await fetch(`${apiBase}/api/chat/sessions`)).json()).total, 1);
    const userLogs = await (await fetch(`${apiBase}/api/admin/chat-logs?query=${encodeURIComponent(email)}`)).json();
    assert.ok(userLogs.total >= 4 && userLogs.logs.every((log: { ownerType: string; userEmail: string }) => log.ownerType === "user" && log.userEmail === email));
    assert.equal((await fetch(`${apiBase}/api/auth/logout`, { method: "POST" })).status, 204);
    assert.equal((await (await fetch(`${apiBase}/api/chat/sessions`)).json()).total, 0, "after logout the browser is a new visitor");
    const adminUsers = await (await fetch(`${apiBase}/api/admin/users?query=${encodeURIComponent(email)}`)).json();
    assert.deepEqual(adminUsers.users.map((user: { id: string; sessionCount: number; disabled: boolean }) => [user.id, user.sessionCount, user.disabled]), [[account.id, 1, false]]);
    assert.equal((await fetch(`${apiBase}/api/admin/users/${account.id}`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ disabled: true }) })).status, 200);
    const userLogin = (credentials: object) => fetch(`${apiBase}/api/auth/login`, { method: "POST", headers: jsonHeaders, body: JSON.stringify(credentials) });
    assert.equal((await userLogin({ email, password: userPassword })).status, 403);
    assert.equal((await fetch(`${apiBase}/api/admin/users/${account.id}`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ disabled: false }) })).status, 200);
    assert.equal((await userLogin({ email: email.toUpperCase(), password: userPassword })).status, 200);
    assert.equal((await (await fetch(`${apiBase}/api/auth/session`)).json()).user.email, email);
    assert.equal((await (await fetch(`${apiBase}/api/chat/sessions`)).json()).total, 1);
    const slow = new AbortController();
    const slowResponse = await fetch(`${apiBase}/api/chat/sessions/${session.id}/stream`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "slow question" }), signal: slow.signal });
    const reader = slowResponse.body!.getReader();
    let received = "";
    while (!received.includes("event: token")) received += new TextDecoder().decode((await reader.read()).value);
    slow.abort();
    await until(async () => chatAborted);
    await delay(200);
    assert.equal((await (await fetch(`${apiBase}/api/chat/sessions/${session.id}/messages`)).json()).messages.length, 2, "an aborted answer is not saved");
    assert.equal((await fetch(`${apiBase}/api/chat/sessions/${session.id}`, { method: "DELETE" })).status, 204);
    assert.equal((await fetch(`${apiBase}/api/chat/sessions/${session.id}/messages`)).status, 404);
    const overview = await (await fetch(`${apiBase}/api/admin/knowledge`)).json();
    assert.equal(overview.sources[0].documentCount, 1);
    assert.equal(overview.stats.documents, 1);

    assert.equal((await fetch(`${apiBase}/api/admin/documents/${documentId}`, { method: "DELETE" })).status, 204);
    assert.equal((await getPool().query("SELECT 1 FROM document_chunks WHERE document_id = $1", [documentId])).rowCount, 0);
    assert.ok(requested >= 4);

    // 文章 API 来源：地址不能带 token；同步后入库、切片并自动向量化；updateTime 变化后重新解析。
    const json = { "content-type": "application/json" };
    const listUrl = `http://127.0.0.1:${mockPort}/nyz/article?tagKey=1`;
    assert.equal((await fetch(`${apiBase}/api/admin/sources`, { method: "POST", headers: json, body: JSON.stringify({ name: "Articles", url: `${listUrl}&token=x`, kind: "文章 API", frequency: "" }) })).status, 400);
    const articleSource = await (await fetch(`${apiBase}/api/admin/sources`, { method: "POST", headers: json, body: JSON.stringify({ name: "Articles", url: listUrl, kind: "文章 API", frequency: "" }) })).json();
    await fetch(`${apiBase}/api/admin/sources/${articleSource.id}`, { method: "PATCH", headers: json, body: JSON.stringify({ status: "运行中" }) });
    async function syncArticles() {
      const task = await (await fetch(`${apiBase}/api/admin/sources/${articleSource.id}/sync`, { method: "POST" })).json();
      await until(async () => ["已完成", "失败"].includes((await getPool().query("SELECT status FROM crawl_tasks WHERE id = $1", [task.id])).rows[0].status));
      const { rows: [row] } = await getPool().query("SELECT status, error FROM crawl_tasks WHERE id = $1", [task.id]);
      assert.equal(row.status, "已完成", row.error ?? output);
      assert.equal(row.error, null);
    }
    const articleDocuments = async () => (await getPool().query(
      "SELECT d.id, d.external_id, d.title, d.content, d.embedding_status, d.metadata, c.context, c.section_path FROM documents d JOIN document_chunks c ON c.document_id = d.id WHERE d.source_id = $1 ORDER BY d.external_id",
      [articleSource.id])).rows;
    await syncArticles();
    let synced = await articleDocuments();
    assert.deepEqual(synced.map((row) => row.external_id), ["a1", "a2"]);
    assert.equal(synced[0].content, "【结论】\n\n文章一的正文结论。", "metadata block and follow-up questions are excluded");
    assert.equal(synced[0].context, "文章：文章一\n章节：【结论】\n关键词：钠离子电池");
    assert.deepEqual(synced[0].metadata.followUpQuestions, ["如何放大？"]);
    await until(async () => (await articleDocuments()).every((row) => row.embedding_status === "ready"));
    // 文章级向量（标题 + 摘要）排在切片之后、同一次请求生成。
    const summaryVectors = await getPool().query("SELECT summary_embedding::text AS summary FROM documents WHERE source_id = $1 ORDER BY external_id", [articleSource.id]);
    assert.deepEqual(summaryVectors.rows.map((row) => row.summary), ["[2,0.5,0.25]", "[2,0.5,0.25]"]);
    const detail = await (await fetch(`${apiBase}/api/admin/documents/${synced[0].id}`)).json();
    assert.equal(detail.externalId, "a1");
    assert.deepEqual(detail.tags, ["钠电"]);
    assert.equal(detail.chunks[0].sectionPath[0], "【结论】");

    const publicDetail = await (await fetch(`${apiBase}/api/documents/${synced[0].id}`)).json();
    assert.equal(publicDetail.title, "文章一");
    assert.equal(publicDetail.repostSource, "测试公众号");
    assert.deepEqual(publicDetail.tags, ["钠电"]);
    assert.equal(publicDetail.rawHtml, undefined);
    assert.equal(publicDetail.chunks, undefined);
    assert.equal((await fetch(`${apiBase}/api/documents/not-found`)).status, 404);
    await getPool().query("UPDATE documents SET status = 'failed' WHERE id = $1", [synced[0].id]);
    assert.equal((await fetch(`${apiBase}/api/documents/${synced[0].id}`)).status, 404, "non-ready documents are not publicly readable");
    await getPool().query("UPDATE documents SET status = 'ready' WHERE id = $1", [synced[0].id]);
    for (const path of ["/api/search", "/api/chat"]) {
      // Request bodies reject unknown fields, so each endpoint gets only its own text field.
      const body = (text: string, filters: object) => JSON.stringify(path === "/api/search" ? { query: text, filters } : { question: text, filters });
      const invalid = await fetch(`${apiBase}${path}`, { method: "POST", headers: json, body: body("文章", { publishedFrom: "2026-02-30" }) });
      assert.equal(invalid.status, 400);
      const filtered = await (await fetch(`${apiBase}${path}`, { method: "POST", headers: json, body: body("文章", { categories: ["not-present"] }) })).json();
      assert.deepEqual(path === "/api/search" ? filtered.results : filtered.sources, []);
      const included = await (await fetch(`${apiBase}${path}`, { method: "POST", headers: json, body: body("文章一", { categories: ["科研"], tags: ["钠电"], sourceId: articleSource.id }) })).json();
      assert.ok((path === "/api/search" ? included.results : included.sources).some((hit: { documentId: string }) => hit.documentId === synced[0].id));
    }
    const filterSession = await (await fetch(`${apiBase}/api/chat/sessions`, { method: "POST", headers: json, body: "{}" })).json();
    const filteredStream = await stream(filterSession.id, { question: "文章", filters: { tags: ["not-present"] } });
    assert.deepEqual(filteredStream.map((item) => item.event), ["done"]);
    const filteredRegenerate = await stream(filterSession.id, { regenerate: filteredStream[0].data.id, filters: { tags: ["not-present"] } });
    assert.deepEqual(filteredRegenerate[0].data.sources, []);
    assert.equal((await fetch(`${apiBase}/api/chat/sessions/${filterSession.id}/stream`, { method: "POST", headers: json, body: JSON.stringify({ question: "文章", filters: { tags: "invalid" } }) })).status, 400);
    const includedStream = await stream(filterSession.id, { question: "文章一", filters: { tags: ["钠电"], sourceId: articleSource.id } });
    assert.ok(includedStream.some((item) => item.event === "source" && item.data.documentId === synced[0].id));

    const articleChat = await (await fetch(`${apiBase}/api/chat`, { method: "POST", headers: json, body: JSON.stringify({ question: "文章一的正文结论" }) })).json();
    assert.deepEqual(articleChat.sources.find((source: { title: string }) => source.title === "文章一"), { documentId: synced[0].id, title: "文章一", url: detail.url, repostSource: "测试公众号" });
    const articleLog = (await (await fetch(`${apiBase}/api/admin/chat-logs?query=${encodeURIComponent("文章一的正文结论")}`)).json()).logs[0];
    assert.ok(articleLog.chunks.find((chunk: { documentId: string }) => chunk.documentId === synced[0].id)?.summaryScore > 0.9, "summary recall contributes to the fused ranking");

    articles.set("a2", article("a2", "文章二（更新）", 200));
    articleRequests.length = 0;
    await syncArticles();
    synced = await articleDocuments();
    assert.equal(synced[1].title, "文章二（更新）");
    assert.deepEqual(articleRequests.filter((path) => path.endsWith("/articleDetail")).length, 1, "only the changed article is fetched again");
    // 网页站点：地址规范化后去重抓取；同来源不同地址的相同正文标记为重复，canonical 别名地址不另存。
    const siteSource = await (await fetch(`${apiBase}/api/admin/sources`, { method: "POST", headers: json, body: JSON.stringify({ name: "Site", url: `http://127.0.0.1:${mockPort}/site/page?id=1`, kind: "网页站点", frequency: "" }) })).json();
    await fetch(`${apiBase}/api/admin/sources/${siteSource.id}`, { method: "PATCH", headers: json, body: JSON.stringify({ status: "运行中" }) });
    const siteTask = await (await fetch(`${apiBase}/api/admin/sources/${siteSource.id}/sync`, { method: "POST" })).json();
    await until(async () => ["已完成", "失败"].includes((await getPool().query("SELECT status FROM crawl_tasks WHERE id = $1", [siteTask.id])).rows[0].status));
    const { rows: [siteTaskRow] } = await getPool().query("SELECT status, error FROM crawl_tasks WHERE id = $1", [siteTask.id]);
    assert.equal(siteTaskRow.status, "已完成", siteTaskRow.error ?? output);
    assert.match(siteTaskRow.error, /1 篇与已有文档内容相同/);
    assert.deepEqual(siteRequests, ["?id=1", "?id=2", "?id=3", "?id=4"], "fragments and tracking params do not cause refetches");
    const siteDocuments = (await getPool().query("SELECT id, url, canonical_url, processing_status, duplicate_of FROM documents WHERE source_id = $1 ORDER BY url", [siteSource.id])).rows;
    const pageUrl = (id: string) => `http://127.0.0.1:${mockPort}/site/page?id=${id}`;
    assert.deepEqual(siteDocuments.map((row) => [row.url, row.canonical_url, row.processing_status]), [
      [pageUrl("1"), pageUrl("1"), "chunked"], [pageUrl("2"), pageUrl("2"), "chunked"], [pageUrl("3"), pageUrl("3"), "duplicate"],
    ]);
    assert.equal(siteDocuments[2].duplicate_of, siteDocuments[0].id);
    assert.equal((await fetch(`${apiBase}/api/admin/documents/${siteDocuments[2].id}/embed`, { method: "POST" })).status, 409, "duplicates are not embedded");
    const primaryDetail = await (await fetch(`${apiBase}/api/admin/documents/${siteDocuments[0].id}`)).json();
    assert.deepEqual(primaryDetail.duplicates.map((item: { id: string }) => item.id), [siteDocuments[2].id]);
    // 删除主文档：重复文档接替，重新切片并向量化。
    assert.equal((await fetch(`${apiBase}/api/admin/documents/${siteDocuments[0].id}`, { method: "DELETE" })).status, 204);
    await until(async () => (await getDocumentSummary(siteDocuments[2].id))?.embedding.status === "ready");
    const promoted = (await getDocumentSummary(siteDocuments[2].id))!;
    assert.equal(promoted.processingStatus, "chunked");
    assert.equal(promoted.duplicateOf, undefined);

    assert.doesNotMatch(output, new RegExp(articleToken));
    assert.doesNotMatch(output, new RegExp(adminPassword));
    assert.doesNotMatch(output, /integration password/);
    assert.equal((await fetch(`${apiBase}/api/admin/auth/logout`, { method: "POST" })).status, 204);
    assert.equal((await fetch(`${apiBase}/api/admin/documents`)).status, 401);
  } finally {
    for (const child of children) {
      if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
    }
    await closeDatabase();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    await admin.end();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  }
});
