import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import pg from "pg";
import { readSnapshot, updateSnapshot } from "../src/snapshot.js";

test("API + queue + worker persist vectors, retry failures and clean stale rows", { skip: process.env.NYZ_INTEGRATION_TEST !== "1", timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "nyz-vector-"));
  const previousPath = process.env.NYZ_STORE_PATH;
  process.env.NYZ_STORE_PATH = join(directory, "knowledge.json");
  const documentId = crypto.randomUUID();
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgresql://nyzrag:nyzrag@localhost:5432/nyzrag" });
  let mode: "ok" | "failure" | "slow" = "ok";
  let requested = 0;
  const server = createServer(async (request, response) => {
    if (request.url !== "/v1/embeddings") { response.writeHead(404).end(); return; }
    assert.equal(request.headers.authorization, "Bearer integration-test-key");
    let body = "";
    for await (const chunk of request) body += chunk;
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
      env: { ...process.env, API_PORT: String(apiPort), DATABASE_URL: pool.options.connectionString, TEST_EMBEDDING_KEY: "integration-test-key", DOCUMENT_QUEUE_NAME: `test-${documentId}` },
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
  async function waitEmbedding(status: string) {
    await until(async () => (await readSnapshot()).documents[0]?.embedding?.status === status);
    // Status is persisted just before BullMQ removes the completed/failed job.
    await delay(100);
  }
  const post = (path: string) => fetch(`${apiBase}/api/admin/documents/${documentId}/${path}`, { method: "POST" });
  try {
    const now = new Date().toISOString();
    await updateSnapshot((snapshot) => {
      snapshot.documents.push({ id: documentId, sourceId: "test", title: "Vector test", url: "https://example.test", content: "First chunk. Second chunk.", status: "ready", processingStatus: "chunked", chunks: [{ id: `${documentId}-1`, index: 0, content: "First chunk.", tokenEstimate: 5 }, { id: `${documentId}-2`, index: 1, content: "Second chunk.", tokenEstimate: 5 }], createdAt: now, updatedAt: now });
      snapshot.modelProviders.push({ id: "test-provider", name: "Local test", provider: "OpenAI 兼容", baseUrl: `http://127.0.0.1:${mockPort}/v1`, embeddingModel: "test-embedding", chatModel: "test-chat", rerankModel: "", credentialEnv: "TEST_EMBEDDING_KEY", enabled: true, isDefault: true, createdAt: now, updatedAt: now });
    });
    start("apps/api/src/index.ts");
    start("apps/worker/src/index.ts");
    await until(async () => { try { return (await fetch(`${apiBase}/health`)).ok; } catch { return false; } });
    assert.equal((await post("embed")).status, 202);
    await waitEmbedding("ready");
    let rows = await pool.query("SELECT chunk_index, embedding::text, dimensions FROM document_vectors WHERE document_id = $1 ORDER BY chunk_index", [documentId]);
    assert.equal(rows.rowCount, 2);
    assert.equal(rows.rows[0].embedding, "[1,0.5,0.25]");
    assert.equal(rows.rows[0].dimensions, 3);
    assert.equal((await readSnapshot()).documents[0].embedding?.chunkCount, 2);

    mode = "failure";
    assert.equal((await post("embed")).status, 202);
    await waitEmbedding("failed");
    assert.doesNotMatch((await readSnapshot()).documents[0].embedding?.error ?? "", /do-not-leak-provider-body|integration-test-key/);
    rows = await pool.query("SELECT * FROM document_vectors WHERE document_id = $1", [documentId]);
    assert.equal(rows.rowCount, 2, "failed replacement preserves previous transaction");

    mode = "slow";
    assert.equal((await post("embed")).status, 202);
    await until(async () => (await readSnapshot()).documents[0].embedding?.status === "processing");
    assert.equal((await post("embed")).status, 409);
    assert.equal((await fetch(`${apiBase}/api/admin/documents/${documentId}`, { method: "DELETE" })).status, 409);
    await updateSnapshot((snapshot) => { snapshot.chatLogs.push({ id: "concurrent-log", question: "Keep me", answer: "Concurrent write", sources: [], rating: null, createdAt: now }); });
    await waitEmbedding("ready");
    assert.equal((await readSnapshot()).chatLogs.length, 1, "worker must preserve API writes made during model request");

    mode = "ok";
    assert.equal((await post("reprocess")).status, 202);
    await waitEmbedding("ready");
    rows = await pool.query("SELECT * FROM document_vectors WHERE document_id = $1", [documentId]);
    assert.equal(rows.rowCount, 1, "reprocessing removes obsolete chunk vectors");
    assert.equal((await fetch(`${apiBase}/api/admin/documents/${documentId}`, { method: "DELETE" })).status, 204);
    rows = await pool.query("SELECT * FROM document_vectors WHERE document_id = $1", [documentId]);
    assert.equal(rows.rowCount, 0);
    assert.ok(requested >= 4);
  } finally {
    for (const child of children) {
      if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
    }
    await pool.query("DELETE FROM document_vectors WHERE document_id = $1", [documentId]).catch(() => {});
    await pool.end();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousPath === undefined) delete process.env.NYZ_STORE_PATH;
    else process.env.NYZ_STORE_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
