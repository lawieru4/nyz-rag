import type { ChatStreamEvent } from "@nyz-rag/types";

/** Error thrown when the server responds with a non-2xx status.
 *  `message` is taken from `data.error` when the body is JSON `{error:string}`,
 *  otherwise falls back to a generic message with the status code. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/** Include session cookies and mark non-GET/HEAD requests with the caller's CSRF header. */
export function withSession(init: RequestInit, csrfHeader: string): RequestInit {
  const headers = new Headers(init.headers);
  if (!["GET", "HEAD"].includes((init.method ?? "GET").toUpperCase())) headers.set(csrfHeader, "1");
  return { ...init, headers, credentials: "include" };
}

async function errorFrom(response: Response): Promise<ApiError> {
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  return new ApiError(response.status, typeof data["error"] === "string" ? data["error"] : `请求失败（${response.status}）`);
}

export interface StreamCallbacks {
  /** Called for each parsed SSE event from the stream. */
  onEvent: (event: ChatStreamEvent) => void;
  /** Called when the stream ends before a "done" event was received. */
  onIncomplete: (reason: string) => void;
}

/** Minimal typed API client.
 *
 * - Prepends `baseUrl` to every path.
 * - Attaches `Content-Type: application/json` for requests with a body.
 * - Unwraps `{error: string}` JSON error bodies into `ApiError`.
 * - Returns `undefined` (cast to `T`) for 204 No Content responses.
 * - Forwards an `AbortSignal` through every call.
 */
export class ApiClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  /** Generic JSON request helper. */
  async request<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const headers = new Headers(init.headers as HeadersInit | undefined);

    // Attach Content-Type for requests that carry a JSON body.
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });

    if (!response.ok) throw await errorFrom(response);

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }

  /** Open an SSE stream to `path` and yield parsed `ChatStreamEvent` objects.
   *
   * - Comments and heartbeat lines (lines starting with `:`) are ignored.
   * - Emits `onIncomplete` if the stream ends without a `done` event.
   * - Aborts cleanly: when `signal` fires the generator returns without
   *   calling `onIncomplete` (cancellation is intentional).
   */
  async stream(
    path: string,
    init: RequestInit,
    callbacks: StreamCallbacks,
  ): Promise<void> {
    const headers = new Headers(init.headers as HeadersInit | undefined);
    if (!headers.has("content-type") && init.body !== undefined) {
      headers.set("content-type", "application/json");
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });

    if (!response.ok || !response.body) throw await errorFrom(response);

    let finished = false;

    try {
      for await (const event of readSseEvents(response.body, init.signal ?? undefined)) {
        callbacks.onEvent(event);
        if (event.event === "done") {
          finished = true;
        }
      }
    } catch (err) {
      // Re-throw all errors except AbortError; that is normal cancellation.
      if (err instanceof Error && err.name === "AbortError") {
        return; // cancelled — do NOT call onIncomplete
      }
      throw err;
    }

    if (!finished) {
      callbacks.onIncomplete("连接已中断，本轮回答未保存。");
    }
  }
}

/** Parse raw SSE bytes from a `ReadableStream<Uint8Array>` and yield
 *  `ChatStreamEvent` objects.  Comment-only blocks are skipped. */
async function* readSseEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<ChatStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      if (signal?.aborted) {
        // Surface as AbortError so the caller can distinguish cancellation.
        const err = new DOMException("Aborted", "AbortError");
        throw err;
      }

      const { value, done } = await reader.read();
      if (done) return;

      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        let eventType = "";
        let data = "";

        for (const line of block.split("\n")) {
          if (line.startsWith(":")) continue; // heartbeat / comment
          if (line.startsWith("event:")) eventType = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }

        if (eventType && data) {
          yield { event: eventType, data: JSON.parse(data) } as ChatStreamEvent;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Factory: create an `ApiClient` from a Vite env variable (browser) or
 *  a plain base-URL string.  Trims trailing slashes automatically. */
export function createApiClient(baseUrl: string): ApiClient {
  return new ApiClient(baseUrl);
}
