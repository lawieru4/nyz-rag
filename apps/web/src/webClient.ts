import { ApiClient, ApiError, withSession, type StreamCallbacks } from "@nyz-rag/api-client";

export { ApiError };

export class WebApiClient extends ApiClient {
  override request<T>(path: string, init: RequestInit = {}): Promise<T> {
    return super.request<T>(path, withSession(init, "X-NYZ-Client"));
  }

  override stream(path: string, init: RequestInit, callbacks: StreamCallbacks): Promise<void> {
    return super.stream(path, withSession(init, "X-NYZ-Client"), callbacks);
  }
}

export const client = new WebApiClient(import.meta.env.VITE_API_URL ?? "http://localhost:3000");
