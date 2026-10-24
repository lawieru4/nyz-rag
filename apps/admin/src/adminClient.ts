import { ApiClient, ApiError, withSession } from "@nyz-rag/api-client";

export { ApiError };

/**
 * 管理端客户端：携带会话 Cookie，非 GET/HEAD 请求附加 CSRF 校验头 `X-NYZ-Admin: 1`；
 * 会话失效（401，登录接口本身除外）时调用 `onUnauthorized`，由外层切回登录页。
 */
export class AdminApiClient extends ApiClient {
  onUnauthorized: (() => void) | null = null;

  override async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const sessionInit = withSession(init, "X-NYZ-Admin");
    try {
      return await super.request<T>(path, sessionInit);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && path !== "/api/admin/auth/login") this.onUnauthorized?.();
      throw err;
    }
  }
}
