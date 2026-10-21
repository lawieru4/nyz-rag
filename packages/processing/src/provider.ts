// OpenAI 兼容供应商的公共部分：接口地址与密钥。错误信息不包含地址、密钥或响应正文。
import type { ModelProviderRecord } from "@nyz-rag/types";

const OPENAI_API_BASE_URL = "https://api.openai.com/v1";

function isKnownOpenAI(provider: ModelProviderRecord): boolean {
  return [provider.name, provider.provider].some((value) => value.trim().toLowerCase() === "openai");
}

/** 基础地址 + 接口路径（如 embeddings、chat/completions、rerank）；label 用于错误信息。 */
export function providerUrl(provider: ModelProviderRecord, path: string, label: string): string {
  const configuredBaseUrl = provider.baseUrl.trim();
  const baseUrl = configuredBaseUrl || (isKnownOpenAI(provider) ? OPENAI_API_BASE_URL : "");
  if (!baseUrl) {
    throw new Error(`The ${label} API base URL is required for this provider.`);
  }

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`The ${label} API base URL is invalid.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`The ${label} API base URL must use HTTP or HTTPS.`);
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${path}`;
  return url.toString();
}

/** 从供应商配置的环境变量读取密钥。 */
export function providerCredential(provider: ModelProviderRecord, label: string): string {
  const credentialName = provider.credentialEnv.trim();
  const apiKey = credentialName ? process.env[credentialName]?.trim() : undefined;
  if (!apiKey) {
    throw new Error(`The configured ${label} API credential is missing.`);
  }
  return apiKey;
}

export const hasProviderCredential = (provider: ModelProviderRecord) => Boolean(provider.credentialEnv.trim() && process.env[provider.credentialEnv.trim()]?.trim());
