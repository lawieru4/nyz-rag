import { ApiClient, ApiError, type StreamCallbacks } from "@nyz-rag/api-client";

export { ApiError };

const SAFE_METHODS = new Set(["GET", "HEAD"]);

/** 携带访客/账号 Cookie；写请求附加 `X-NYZ-Client: 1`（API 据此防 CSRF）。 */
function withSession(init: RequestInit): RequestInit {
  const headers = new Headers(init.headers);
  if (!SAFE_METHODS.has((init.method ?? "GET").toUpperCase())) headers.set("X-NYZ-Client", "1");
  return { ...init, headers, credentials: "include" };
}

export class WebApiClient extends ApiClient {
  override request<T>(path: string, init: RequestInit = {}): Promise<T> {
    return super.request<T>(path, withSession(init));
  }

  override stream(path: string, init: RequestInit, callbacks: StreamCallbacks): Promise<void> {
    return super.stream(path, withSession(init), callbacks);
  }
}

export const client = new WebApiClient(import.meta.env.VITE_API_URL ?? "http://localhost:3000");
