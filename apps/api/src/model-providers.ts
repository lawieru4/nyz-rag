import type { FastifyPluginAsync, FastifyReply } from "fastify";
import {
  createModelProvider, credentialEnvAllowed, deleteModelProvider, deleteModelSetting, getModelSettings, listModelProviderConfigs, listModelProviders, listProviderModels,
  providerCredential, providerOrigin, saveModelSetting, secretKeyConfigured, updateModelProvider, type ModelProviderConfig,
} from "@nyz-rag/processing";
import type { ListProviderModelsRequest, ModelCapability, SaveModelProviderRequest, SaveModelSettingRequest } from "@nyz-rag/types";
import { superAdminOnly } from "./admin-auth.js";

const CAPABILITY_LABELS: Record<ModelCapability, string> = { chat: "Chat", embedding: "Embedding", rerank: "Rerank", review: "审核" };

function validBaseUrl(url: string) {
  if (!url) return true;
  try { return ["http:", "https:"].includes(new URL(url).protocol); }
  catch { return false; }
}

const credentialEnvNotAllowed = (name: string) => `环境变量 ${name} 不在 NYZ_MODEL_CREDENTIAL_ENVS 允许列表中`;

/** 已保存的密钥只发往保存时的地址：地址的 origin 变化后，须重新填写或清除密钥。 */
const keepsSavedKeyOnNewOrigin = (saved: ModelProviderConfig, body: Pick<SaveModelProviderRequest, "name" | "provider" | "baseUrl">) =>
  Boolean(saved.apiKeyCiphertext) && providerOrigin(body) !== providerOrigin(saved);

/** 请求体的业务校验（saved 为更新前的供应商）；不通过时回复 4xx/503 并返回 false。 */
function checkProvider(body: SaveModelProviderRequest, reply: FastifyReply, saved?: ModelProviderConfig): boolean {
  const credentialEnv = body.credentialEnv?.trim() ?? "";
  const invalid = !validBaseUrl(body.baseUrl) ? "baseUrl must be a valid http(s) URL"
    : body.apiKey?.trim() && body.clearApiKey ? "apiKey 与 clearApiKey 不能同时提供"
    // 未改动的旧配置照常保存（如停用供应商），运行时由 providerCredential 拒绝读取。
    : credentialEnv && credentialEnv !== saved?.credentialEnv && !credentialEnvAllowed(credentialEnv) ? credentialEnvNotAllowed(credentialEnv)
    : saved && !body.apiKey?.trim() && !body.clearApiKey && keepsSavedKeyOnNewOrigin(saved, body) ? "修改接口地址后须重新填写 API Key，或清除已保存的密钥"
    : null;
  if (invalid) {
    reply.code(400).send({ error: invalid });
    return false;
  }
  if (body.apiKey?.trim() && !secretKeyConfigured()) {
    reply.code(503).send({ error: "服务端未配置可用的 NYZ_SECRET_KEY，无法保存密钥" });
    return false;
  }
  return true;
}

/** 列出供应商的模型；错误信息由 processing 生成，不含地址、密钥或响应正文。 */
async function providerModels(provider: Pick<ModelProviderConfig, "name" | "provider" | "baseUrl">, apiKey: () => string | null, reply: FastifyReply) {
  try {
    return { models: await listProviderModels(provider, apiKey()) };
  } catch (error) {
    return reply.code(502).send({ error: `获取模型列表失败：${error instanceof Error ? error.message : "unknown error"}` });
  }
}

export const modelProviderRoutes: FastifyPluginAsync = async (app) => {
  // ---- 供应商：只描述连接（地址、密钥、启用） ----

  app.get("/api/admin/model-providers", async () => listModelProviders());

  // 除读取列表外均仅限超级管理员：这些操作会保存密钥、或带着密钥请求外部地址。
  app.post<{ Body: SaveModelProviderRequest }>("/api/admin/model-providers", superAdminOnly, async (request, reply) => {
    if (!checkProvider(request.body, reply)) return reply;
    return reply.code(201).send(await createModelProvider({ ...request.body, name: request.body.name.trim() }));
  });

  app.patch<{ Params: { id: string }; Body: SaveModelProviderRequest }>("/api/admin/model-providers/:id", superAdminOnly, async (request, reply) => {
    const saved = (await listModelProviderConfigs()).find((provider) => provider.id === request.params.id);
    if (!saved) return reply.code(404).send({ error: "model provider not found" });
    if (!checkProvider(request.body, reply, saved)) return reply;
    const updated = await updateModelProvider(request.params.id, { ...request.body, name: request.body.name.trim() });
    if (!updated) return reply.code(404).send({ error: "model provider not found" });
    return updated;
  });

  app.delete<{ Params: { id: string } }>("/api/admin/model-providers/:id", superAdminOnly, async (request, reply) => {
    const { deleted, usedBy } = await deleteModelProvider(request.params.id);
    if (usedBy.length) {
      const labels = (Object.keys(CAPABILITY_LABELS) as ModelCapability[]).filter((capability) => usedBy.includes(capability)).map((capability) => CAPABILITY_LABELS[capability]);
      return reply.code(409).send({ error: `该供应商正用于 ${labels.join("、")} 模型，请先更换业务模型` });
    }
    if (!deleted) return reply.code(404).send({ error: "model provider not found" });
    return reply.code(204).send();
  });

  // 测试连接：按表单中的地址获取可选模型。密钥依次取：表单填写的 apiKey、已保存供应商的密钥（providerId，仅限原地址）、
  // credentialEnv 指定的环境变量（须在 NYZ_MODEL_CREDENTIAL_ENVS 中）；都没有时不带认证头。
  app.post<{ Body: ListProviderModelsRequest }>("/api/admin/model-providers/models", superAdminOnly, async (request, reply) => {
    const { apiKey, providerId, credentialEnv, ...endpoint } = request.body;
    const envName = credentialEnv?.trim() ?? "";
    if (!validBaseUrl(endpoint.baseUrl)) return reply.code(400).send({ error: "baseUrl must be a valid http(s) URL" });
    let saved: ModelProviderConfig | undefined;
    if (!apiKey?.trim()) {
      // 先校验允许名单再判断是否有值，避免借报错探测任意环境变量是否存在。
      if (envName && !credentialEnvAllowed(envName)) return reply.code(400).send({ error: credentialEnvNotAllowed(envName) });
      if (providerId) {
        saved = (await listModelProviderConfigs()).find((provider) => provider.id === providerId);
        if (!saved) return reply.code(404).send({ error: "model provider not found" });
        if (keepsSavedKeyOnNewOrigin(saved, { name: endpoint.name ?? "", provider: endpoint.provider, baseUrl: endpoint.baseUrl })) {
          return reply.code(400).send({ error: "接口地址与已保存的不同，请填写 API Key 后再测试" });
        }
      } else if (envName && !process.env[envName]?.trim()) {
        return reply.code(400).send({ error: `环境变量 ${envName} 未设置` });
      }
    }
    const key = () => apiKey?.trim()
      || (saved ? providerCredential({ ...saved, credentialEnv: credentialEnv ?? saved.credentialEnv }, "model list") : null)
      || (envName ? process.env[envName]!.trim() : null);
    return providerModels({ name: endpoint.name ?? "", provider: endpoint.provider, baseUrl: endpoint.baseUrl }, key, reply);
  });

  // 已保存供应商的可选模型，供业务模型选择。
  app.get<{ Params: { id: string } }>("/api/admin/model-providers/:id/models", superAdminOnly, async (request, reply) => {
    const saved = (await listModelProviderConfigs()).find((provider) => provider.id === request.params.id);
    if (!saved) return reply.code(404).send({ error: "model provider not found" });
    return providerModels(saved, () => providerCredential(saved, "model list"), reply);
  });

  // ---- 业务模型：Chat / Embedding / Rerank / 审核各选一个供应商与模型 ----

  app.get("/api/admin/model-settings", async () => getModelSettings());

  app.put<{ Params: { capability: ModelCapability }; Body: SaveModelSettingRequest }>("/api/admin/model-settings/:capability", superAdminOnly, async (request, reply) => {
    const provider = (await listModelProviders()).find((item) => item.id === request.body.providerId);
    if (!provider) return reply.code(400).send({ error: "供应商不存在" });
    if (!provider.enabled) return reply.code(400).send({ error: "供应商已停用，请先启用" });
    return saveModelSetting(request.params.capability, request.body);
  });

  app.delete<{ Params: { capability: ModelCapability } }>("/api/admin/model-settings/:capability", superAdminOnly, async (request, reply) => {
    await deleteModelSetting(request.params.capability);
    return reply.code(204).send();
  });
};
