import { ApiClient, ApiError } from "@nyz-rag/api-client";

export { ApiError };

const SAFE_METHODS = new Set(["GET", "HEAD"]);

/**
 * 管理端客户端：携带会话 Cookie，非 GET/HEAD 请求附加 CSRF 校验头 `X-NYZ-Admin: 1`；
 * 会话失效（401，登录接口本身除外）时调用 `onUnauthorized`，由外层切回登录页。
 */
export class AdminApiClient extends ApiClient {
  onUnauthorized: (() => void) | null = null;

  override async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (!SAFE_METHODS.has((init.method ?? "GET").toUpperCase())) headers.set("X-NYZ-Admin", "1");
    try {
      return await super.request<T>(path, { ...init, headers, credentials: "include" });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && path !== "/api/admin/auth/login") this.onUnauthorized?.();
      throw err;
    }
  }
}
