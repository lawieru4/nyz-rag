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
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://mock");
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
  let output = "";
  const children: ChildProcess[] = [];
  const start = (entry: string) => {
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), entry], {
      cwd: new URL("../../../", import.meta.url),
      env: {
        ...process.env, API_PORT: String(apiPort), DATABASE_URL: testUrl.toString(), TEST_EMBEDDING_KEY: "integration-test-key", DOCUMENT_QUEUE_NAME: `test-${schema}`,
        NYZ_ARTICLE_TOKEN: articleToken, CRAWL_REQUEST_DELAY_MS: "1000",
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
    await until(async () => (await getPool().query("SELECT 1 FROM document_chunks WHERE document_id = $1 AND search_vector <> ''::tsvector", [documentId])).rowCount === 2);

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
    const overview = await (await fetch(`${apiBase}/api/knowledge`)).json();
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
      const invalid = await fetch(`${apiBase}${path}`, { method: "POST", headers: json, body: JSON.stringify({ query: "文章", question: "文章", filters: { publishedFrom: "2026-02-30" } }) });
      assert.equal(invalid.status, 400);
      const filtered = await (await fetch(`${apiBase}${path}`, { method: "POST", headers: json, body: JSON.stringify({ query: "文章", question: "文章", filters: { categories: ["not-present"] } }) })).json();
      assert.deepEqual(path === "/api/search" ? filtered.results : filtered.sources, []);
      const included = await (await fetch(`${apiBase}${path}`, { method: "POST", headers: json, body: JSON.stringify({ query: "文章一", question: "文章一", filters: { categories: ["科研"], tags: ["钠电"], sourceId: articleSource.id } }) })).json();
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

    articles.set("a2", article("a2", "文章二（更新）", 200));
    articleRequests.length = 0;
    await syncArticles();
    synced = await articleDocuments();
    assert.equal(synced[1].title, "文章二（更新）");
    assert.deepEqual(articleRequests.filter((path) => path.endsWith("/articleDetail")).length, 1, "only the changed article is fetched again");
    assert.doesNotMatch(output, new RegExp(articleToken));
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
