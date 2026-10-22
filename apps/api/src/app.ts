import cors from "@fastify/cors";
import Fastify, { type FastifyServerOptions } from "fastify";
import { chatRoutes } from "./chat.js";
import { commonRoutes, configureCommon } from "./common.js";
import { crawlTaskRoutes } from "./crawl-tasks.js";
import { dataSourceRoutes } from "./data-sources.js";
import { documentRoutes } from "./documents.js";
import { knowledgeBaseRoutes } from "./knowledge-bases.js";
import { modelProviderRoutes } from "./model-providers.js";
import { createDocumentQueue, type DocumentQueue } from "./queue.js";
import { searchRoutes } from "./search.js";

export function buildApp(options: { logger?: FastifyServerOptions["logger"]; queue?: DocumentQueue } = {}) {
  const app = Fastify({ logger: options.logger ?? false, ajv: { customOptions: { coerceTypes: false, removeAdditional: false } } });
  const queue = options.queue ?? createDocumentQueue();
  app.addHook("onClose", async () => queue.close());
  configureCommon(app);
  app.register(cors, { origin: true });
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
