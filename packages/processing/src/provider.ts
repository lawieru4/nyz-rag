// OpenAI 兼容供应商的公共部分：业务模型、接口地址与密钥。错误信息不包含地址、密钥或响应正文。
import type { ModelCapability, ModelProviderRecord } from "@nyz-rag/types";
import { decryptSecret, providerSecretContext } from "./secrets.js";

export type { ModelCapability };

const OPENAI_API_BASE_URL = "https://api.openai.com/v1";

/** 运行时使用的供应商配置：在接口记录之外带上后台保存的密钥密文（不返回给前端）。 */
export type ModelProviderConfig = ModelProviderRecord & { apiKeyCiphertext?: string | null };

/** 某项用途实际调用的模型：业务模型配置选定的供应商（已启用）与模型名；temperature / maxTokens 只用于 Chat。 */
export interface ModelSelection {
  provider: ModelProviderConfig;
  model: string;
  temperature: number;
  maxTokens: number;
}

/** 模型调用只需要供应商与模型名。 */
export type ModelTarget = Pick<ModelSelection, "provider" | "model">;

type ProviderEndpoint = Pick<ModelProviderRecord, "name" | "provider" | "baseUrl">;

function isKnownOpenAI(provider: ProviderEndpoint): boolean {
  return [provider.name, provider.provider].some((value) => value.trim().toLowerCase() === "openai");
}

/** 基础地址 + 接口路径（如 embeddings、chat/completions、rerank）；label 用于错误信息。 */
export function providerUrl(provider: ProviderEndpoint, path: string, label: string): string {
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

/**
 * 供应商密钥：后台保存的密钥优先，其次为 credentialEnv 指定的环境变量；都未配置时返回 null（不带认证头，如本地模型）。
 * 指定了环境变量但没有值、或已保存的密钥无法解密时报错。
 */
export function providerCredential(provider: ModelProviderConfig, label: string): string | null {
  if (provider.apiKeyCiphertext) return decryptSecret(provider.apiKeyCiphertext, providerSecretContext(provider.id));
  const credentialName = provider.credentialEnv.trim();
  if (!credentialName) return null;
  const apiKey = process.env[credentialName]?.trim();
  if (!apiKey) {
    throw new Error(`The configured ${label} API credential is missing.`);
  }
  return apiKey;
}

/** 密钥配置可用（含无需密钥的情况）。 */
export function hasProviderCredential(provider: ModelProviderConfig): boolean {
  try {
    providerCredential(provider, "model");
    return true;
  } catch {
    return false;
  }
}

/** 已配置且密钥可用的模型；密钥不可用（环境变量缺失、无法解密）时视为未配置。 */
export const usableModel = <T extends ModelTarget>(selection: T | null): T | null =>
  selection && hasProviderCredential(selection.provider) ? selection : null;

export const authorizationHeaders = (apiKey: string | null): Record<string, string> => apiKey ? { authorization: `Bearer ${apiKey}` } : {};
