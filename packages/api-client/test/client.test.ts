/**
 * Unit tests for packages/api-client using node:test + tsx.
 *
 * These tests stub globalThis.fetch with lightweight mock implementations so
 * they run without a live network and without external test dependencies.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ApiClient, ApiError, errorMessage, withSession } from "../src/index.js";

// ---------------------------------------------------------------------------
// Fetch-stub helpers
// ---------------------------------------------------------------------------

type FetchStub = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

let savedFetch: typeof fetch;

function installFetch(stub: FetchStub): void {
  (globalThis as Record<string, unknown>)["fetch"] = stub;
}

function restoreFetch(): void {
  (globalThis as Record<string, unknown>)["fetch"] = savedFetch;
}

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function make204Response(): Response {
  return new Response(null, { status: 204 });
}

// Build a ReadableStream<Uint8Array> from an array of SSE block strings.
function makeSseStream(blocks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < blocks.length) {
        controller.enqueue(encoder.encode(blocks[index++]!));
      } else {
        controller.close();
      }
    },
  });
}

function makeSseResponse(blocks: string[], status = 200): Response {
  return new Response(makeSseStream(blocks), {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

// ---------------------------------------------------------------------------
// Save/restore globalThis.fetch around the whole suite
// ---------------------------------------------------------------------------

before(() => {
  savedFetch = globalThis.fetch;
});

after(() => {
  restoreFetch();
});

describe("errorMessage", () => {
  it("returns only ApiError messages, including an empty message", () => {
    assert.equal(errorMessage(new ApiError(400, "server message"), "fallback"), "server message");
    assert.equal(errorMessage(new ApiError(400, ""), "fallback"), "");
    for (const err of [new Error("network error"), { message: "not an ApiError" }, "error", null, undefined]) {
      assert.equal(errorMessage(err, "fallback"), "fallback");
    }
  });
});

describe("withSession", () => {
  for (const csrfHeader of ["X-NYZ-Client", "X-NYZ-Admin"]) {
    it(`uses ${csrfHeader} only for non-GET/HEAD methods`, () => {
      for (const method of [undefined, "GET", "get", "HEAD", "head", "POST", "post", "PUT", "PATCH", "DELETE", "OPTIONS", ""]) {
        const init = withSession({ method, credentials: "omit" }, csrfHeader);
        const safe = method === undefined || ["GET", "HEAD"].includes(method.toUpperCase());
        assert.ok(init.headers instanceof Headers);
        assert.equal(init.headers.get(csrfHeader), safe ? null : "1");
        assert.equal(init.headers.has(csrfHeader === "X-NYZ-Client" ? "X-NYZ-Admin" : "X-NYZ-Client"), false);
        assert.equal(init.credentials, "include");
        assert.equal(init.method, method);
      }
    });

    it(`copies every HeadersInit form without mutating the caller for ${csrfHeader}`, () => {
      const entries: [string, string][] = [[csrfHeader.toLowerCase(), "original"], ["X-Custom", "kept"]];
      for (const headers of [new Headers(entries), Object.fromEntries(entries), entries]) {
        const init: RequestInit = Object.freeze({ method: "POST", headers, credentials: "same-origin", body: "{}", signal: new AbortController().signal });
        const result = withSession(init, csrfHeader);
        assert.notEqual(result, init);
        assert.notEqual(result.headers, headers);
        assert.ok(result.headers instanceof Headers);
        assert.equal(result.headers.get(csrfHeader), "1");
        assert.equal(result.headers.get("x-custom"), "kept");
        assert.equal(new Headers(headers).get(csrfHeader), "original");
        assert.equal(init.credentials, "same-origin");
        assert.equal(result.body, init.body);
        assert.equal(result.signal, init.signal);
        for (const method of [undefined, "get", "HEAD"]) {
          const safe = withSession({ ...init, method }, csrfHeader);
          assert.equal(new Headers(safe.headers).get(csrfHeader), "original");
        }
      }
    });
  }

  it("preserves session options and custom content type through JSON requests and SSE", async () => {
    const client = new ApiClient("http://api.test");
    const signal = new AbortController().signal;
    const headers = new Headers({ "Content-Type": "text/plain", "X-Custom": "kept" });
    let calls = 0;
    installFetch((_input, init) => {
      calls++;
      assert.equal(init?.credentials, "include");
      assert.equal(init?.signal, signal);
      assert.equal(init?.body, "{}");
      const actualHeaders = new Headers(init?.headers);
      assert.equal(actualHeaders.get("X-NYZ-Client"), "1");
      assert.equal(actualHeaders.get("content-type"), "text/plain");
      assert.equal(actualHeaders.get("X-Custom"), "kept");
      return Promise.resolve(calls === 1 ? makeJsonResponse({}) : makeSseResponse(['event: done\ndata: {}\n\n']));
    });
    const init = withSession({ method: "POST", body: "{}", signal, headers }, "X-NYZ-Client");
    await client.request("/json", init);
    await client.stream("/stream", init, { onEvent: () => {}, onIncomplete: () => assert.fail("unexpected incomplete stream") });
    assert.equal(calls, 2);
    assert.equal(headers.has("X-NYZ-Client"), false);
  });
});

// ---------------------------------------------------------------------------
// ApiClient.request — JSON/204 responses
// ---------------------------------------------------------------------------

describe("ApiClient.request", () => {
  it("returns parsed JSON for 200 OK", async () => {
    installFetch(() => Promise.resolve(makeJsonResponse({ hello: "world" })));
    const client = new ApiClient("http://api.test");
    const result = await client.request<{ hello: string }>("/test");
    assert.deepEqual(result, { hello: "world" });
  });

  it("returns undefined for 204 No Content", async () => {
    installFetch(() => Promise.resolve(make204Response()));
    const client = new ApiClient("http://api.test");
    const result = await client.request<undefined>("/empty");
    assert.equal(result, undefined);
  });

  it("throws ApiError with server error message for non-2xx JSON body", async () => {
    installFetch(() =>
      Promise.resolve(makeJsonResponse({ error: "not found" }, 404)),
    );
    const client = new ApiClient("http://api.test");
    await assert.rejects(
      () => client.request("/missing"),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 404);
        assert.equal(err.message, "not found");
        return true;
      },
    );
  });

  it("throws ApiError with generic message when body has no error field", async () => {
    installFetch(() =>
      Promise.resolve(makeJsonResponse({ detail: "oops" }, 500)),
    );
    const client = new ApiClient("http://api.test");
    await assert.rejects(
      () => client.request("/boom"),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 500);
        assert.match(err.message, /500/);
        return true;
      },
    );
  });

  it("sends Content-Type: application/json when body is provided", async () => {
    let capturedRequest: Request | undefined;
    installFetch((input, init) => {
      capturedRequest = new Request(input, init);
      return Promise.resolve(makeJsonResponse({}));
    });
    const client = new ApiClient("http://api.test");
    await client.request("/post", { method: "POST", body: JSON.stringify({ q: 1 }) });
    assert.ok(capturedRequest);
    assert.equal(
      capturedRequest.headers.get("content-type"),
      "application/json",
    );
  });

  it("does not override an existing Content-Type header", async () => {
    let capturedRequest: Request | undefined;
    installFetch((input, init) => {
      capturedRequest = new Request(input, init);
      return Promise.resolve(makeJsonResponse({}));
    });
    const client = new ApiClient("http://api.test");
    await client.request("/post", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "raw",
    });
    assert.ok(capturedRequest);
    assert.equal(capturedRequest.headers.get("content-type"), "text/plain");
  });

  it("prepends baseUrl correctly and strips trailing slash", async () => {
    let capturedUrl = "";
    installFetch((input) => {
      capturedUrl = typeof input === "string" ? input : (input as URL).toString();
      return Promise.resolve(makeJsonResponse({}));
    });
    const client = new ApiClient("http://api.test/");
    await client.request("/api/resource");
    assert.equal(capturedUrl, "http://api.test/api/resource");
  });
});

// ---------------------------------------------------------------------------
// ApiClient.stream — SSE
// ---------------------------------------------------------------------------

describe("ApiClient.stream", () => {
  it("calls onEvent for each source, token and done event", async () => {
    const blocks = [
      "event: source\ndata: {\"documentId\":\"d1\",\"title\":\"T\",\"url\":\"http://x\",\"citation\":1}\n\n",
      "event: token\ndata: {\"content\":\"hello\"}\n\n",
      "event: done\ndata: {\"id\":\"m1\",\"question\":\"q\",\"answer\":\"hello\",\"answerMode\":\"generated\",\"sources\":[],\"rating\":null,\"createdAt\":\"2024-01-01T00:00:00Z\"}\n\n",
    ];
    installFetch(() => Promise.resolve(makeSseResponse(blocks)));

    const client = new ApiClient("http://api.test");
    const received: string[] = [];

    await client.stream(
      "/api/chat/sessions/s1/stream",
      { method: "POST", body: "{}" },
      {
        onEvent: (ev) => received.push(ev.event),
        onIncomplete: (msg) => { throw new Error(`unexpected: ${msg}`); },
      },
    );

    assert.deepEqual(received, ["source", "token", "done"]);
  });

  it("calls onIncomplete when stream ends without done", async () => {
    const blocks = [
      "event: token\ndata: {\"content\":\"partial\"}\n\n",
    ];
    installFetch(() => Promise.resolve(makeSseResponse(blocks)));

    const client = new ApiClient("http://api.test");
    let incomplete = "";

    await client.stream(
      "/api/chat/sessions/s1/stream",
      { method: "POST", body: "{}" },
      {
        onEvent: () => {},
        onIncomplete: (reason) => { incomplete = reason; },
      },
    );

    assert.ok(incomplete.length > 0, "onIncomplete should be called");
  });

  it("skips heartbeat comment lines", async () => {
    const blocks = [
      ": heartbeat\n\n",
      "event: done\ndata: {\"id\":\"m2\",\"question\":\"q\",\"answer\":\"a\",\"answerMode\":\"generated\",\"sources\":[],\"rating\":null,\"createdAt\":\"2024-01-01T00:00:00Z\"}\n\n",
    ];
    installFetch(() => Promise.resolve(makeSseResponse(blocks)));

    const client = new ApiClient("http://api.test");
    const received: string[] = [];

    await client.stream(
      "/stream",
      { method: "POST", body: "{}" },
      {
        onEvent: (ev) => received.push(ev.event),
        onIncomplete: (msg) => { throw new Error(`unexpected: ${msg}`); },
      },
    );

    assert.deepEqual(received, ["done"]);
  });

  it("throws ApiError when server returns non-2xx for stream endpoint", async () => {
    installFetch(() =>
      Promise.resolve(makeJsonResponse({ error: "unauthorized" }, 401)),
    );

    const client = new ApiClient("http://api.test");
    await assert.rejects(
      () =>
        client.stream("/stream", { method: "POST", body: "{}" }, {
          onEvent: () => {},
          onIncomplete: () => {},
        }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 401);
        assert.equal(err.message, "unauthorized");
        return true;
      },
    );
  });

  it("does not call onIncomplete when aborted via AbortSignal", async () => {
    // Stream that never ends (simulated by an AbortController firing first).
    const controller = new AbortController();

    // We provide a mock response whose body resolves only after abort.
    installFetch((_input, _init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          // Abort before enqueueing anything.
          controller.abort();
          // Close after abort so reader.read() returns.
          ctrl.close();
        },
      });
      return Promise.resolve(
        new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
      );
    });

    const client = new ApiClient("http://api.test");
    let incompleteCalled = false;

    await client.stream(
      "/stream",
      { method: "POST", body: "{}", signal: controller.signal },
      {
        onEvent: () => {},
        onIncomplete: () => { incompleteCalled = true; },
      },
    );

    assert.equal(incompleteCalled, false, "onIncomplete must NOT be called on abort");
  });
});
