import type { FastifyPluginAsync } from "fastify";
import { ARTICLE_TOKEN_SETTING, deleteSecretSetting, getSecretSettingStatus, saveSecretSetting, secretKeyConfigured } from "@nyz-rag/processing";
import type { SaveSecretSettingRequest } from "@nyz-rag/types";
import { superAdminOnly } from "./admin-auth.js";

/** 后台配置的全局密钥：只能写入或清除（仅超级管理员），读取只返回是否已配置。 */
export const settingRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/admin/settings/article-token", async () => getSecretSettingStatus(ARTICLE_TOKEN_SETTING));

  app.put<{ Body: SaveSecretSettingRequest }>("/api/admin/settings/article-token", superAdminOnly, async (request, reply) => {
    if (!secretKeyConfigured()) return reply.code(503).send({ error: "服务端未配置可用的 NYZ_SECRET_KEY，无法保存 token" });
    return saveSecretSetting(ARTICLE_TOKEN_SETTING, request.body.value);
  });

  app.delete("/api/admin/settings/article-token", superAdminOnly, async (_request, reply) => {
    await deleteSecretSetting(ARTICLE_TOKEN_SETTING);
    return reply.code(204).send();
  });
};
