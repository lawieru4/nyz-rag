import cors from "@fastify/cors";
import Fastify, { type FastifyRequest, type FastifyServerOptions } from "fastify";
import { chatRoutes } from "./chat.js";
import { commonRoutes, configureCommon } from "./common.js";
import { crawlTaskRoutes } from "./crawl-tasks.js";
import { dataSourceRoutes } from "./data-sources.js";
import { documentRoutes } from "./documents.js";
import { knowledgeBaseRoutes } from "./knowledge-bases.js";
import { modelProviderRoutes } from "./model-providers.js";
import { createDocumentQueue, type DocumentQueue } from "./queue.js";
import { searchRoutes } from "./search.js";
import { adminAuthConfig, configureAdminAuth, createAdminAuthStore, type AdminAuthConfig, type AdminAuthStore } from "./admin-auth.js";

export function buildApp(options: { logger?: FastifyServerOptions["logger"]; queue?: DocumentQueue; adminAuth?: AdminAuthConfig; authStore?: AdminAuthStore } = {}) {
  const auth = options.adminAuth ?? adminAuthConfig();
  const app = Fastify({ logger: options.logger ?? false, ajv: { customOptions: { coerceTypes: false, removeAdditional: false } } });
  const queue = options.queue ?? createDocumentQueue();
  app.addHook("onClose", async () => queue.close());
  configureCommon(app);
  app.register(cors, {
    delegator: async (request: FastifyRequest) => request.url.startsWith("/api/admin/")
      ? { origin: auth.origins, credentials: true, allowedHeaders: ["Content-Type", "X-NYZ-Admin"], methods: ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"] }
      : { origin: true, credentials: false },
  });
  app.after(() => configureAdminAuth(app, auth, options.authStore ?? createAdminAuthStore()));
  app.register(commonRoutes);
  app.register(chatRoutes);
  app.register(searchRoutes);
  app.register(documentRoutes, { queue });
  app.register(dataSourceRoutes);
  app.register(crawlTaskRoutes, { queue });
  app.register(knowledgeBaseRoutes);
  app.register(modelProviderRoutes);
  return app;
}
