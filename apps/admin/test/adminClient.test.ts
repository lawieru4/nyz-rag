import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AdminApiClient, ApiError } from "../src/adminClient.ts";

const savedFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = savedFetch; });

function installFetch(stub: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = stub as typeof fetch;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("applies only the admin session header to JSON requests", async () => {
  installFetch((_input, init) => {
    assert.equal(init?.credentials, "include");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("X-NYZ-Admin"), "1");
    assert.equal(headers.has("X-NYZ-Client"), false);
    assert.equal(headers.get("content-type"), "application/json");
    return Promise.resolve(jsonResponse({ ok: true }));
  });
  assert.deepEqual(await new AdminApiClient("http://api.test").request("/api/admin/test", { method: "POST", body: "{}" }), { ok: true });
});

test("notifies only for non-login ApiError 401 and rethrows the same error", async () => {
  const client = new AdminApiClient("http://api.test");
  let notifications = 0;
  client.onUnauthorized = () => { notifications++; };
  for (const [path, err, expected] of [
    ["/api/admin/test", new ApiError(401, "expired"), 1],
    ["/api/admin/auth/login", new ApiError(401, "invalid login"), 1],
    ["/api/admin/auth/login?next=home", new ApiError(401, "expired"), 2],
    ["/api/admin/test", new ApiError(403, "forbidden"), 2],
    ["/api/admin/test", new Error("network"), 2],
    ["/api/admin/test", { status: 401 }, 2],
  ] as const) {
    installFetch(() => Promise.reject(err));
    await assert.rejects(client.request(path), (actual: unknown) => actual === err);
    assert.equal(notifications, expected);
  }
  client.onUnauthorized = null;
  const err = new ApiError(401, "expired without handler");
  installFetch(() => Promise.reject(err));
  await assert.rejects(client.request("/api/admin/test"), (actual: unknown) => actual === err);
});

test("handles HTTP 401 responses but leaves inherited streams unchanged", async () => {
  const client = new AdminApiClient("http://api.test");
  let notifications = 0;
  client.onUnauthorized = () => { notifications++; };
  installFetch(() => Promise.resolve(jsonResponse({ error: "expired" }, 401)));
  await assert.rejects(client.request("/api/admin/test"), { name: "ApiError", status: 401, message: "expired" });
  await assert.rejects(client.request("/api/admin/auth/login"), { name: "ApiError", status: 401 });
  installFetch((_input, init) => {
    assert.equal(init?.credentials, undefined);
    assert.equal(new Headers(init?.headers).has("X-NYZ-Admin"), false);
    return Promise.resolve(jsonResponse({ error: "expired" }, 401));
  });
  await assert.rejects(client.stream("/stream", { method: "POST" }, { onEvent: () => {}, onIncomplete: () => {} }), { status: 401 });
  assert.equal(notifications, 1);
});
