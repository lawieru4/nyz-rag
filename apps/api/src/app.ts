import cors from "@fastify/cors";
import Fastify, { type FastifyRequest, type FastifyServerOptions } from "fastify";
import { createRedisAdmissionLimiter, type AdmissionLimiter } from "@nyz-rag/processing";
import { adminAccountRoutes } from "./admin-accounts.js";
import { chatRoutes } from "./chat.js";
import { commonRoutes, configureCommon } from "./common.js";
import { crawlTaskRoutes } from "./crawl-tasks.js";
import { dataSourceRoutes } from "./data-sources.js";
import { documentRoutes } from "./documents.js";
import { knowledgeBaseRoutes } from "./knowledge-bases.js";
import { createMailer, type Mailer } from "./mailer.js";
import { modelProviderRoutes } from "./model-providers.js";
import { createDocumentQueue, type DocumentQueue } from "./queue.js";
import { searchRoutes } from "./search.js";
import { settingRoutes } from "./settings.js";
import { adminAuthConfig, configureAdminAuth, createAdminAuthStore, databaseAdmins, type AdminAuthConfig, type AdminRepository } from "./admin-auth.js";
import { createAuthStore, type AuthStore } from "./auth-store.js";
import { configureUserAuth, databaseUsers, userAuthConfig, type UserAuthConfig, type UserRepository } from "./user-auth.js";
import { userRoutes } from "./users.js";
import { configureRateLimits, rateLimitConfig, trustedProxies } from "./rate-limit.js";

export function buildApp(options: {
  logger?: FastifyServerOptions["logger"]; queue?: DocumentQueue;
  adminAuth?: AdminAuthConfig; authStore?: AuthStore; admins?: AdminRepository;
  userAuth?: UserAuthConfig; userAuthStore?: AuthStore; mailer?: Mailer | null; users?: UserRepository;
  limiter?: AdmissionLimiter; rateLimits?: ReturnType<typeof rateLimitConfig>;
} = {}) {
  const auth = options.adminAuth ?? adminAuthConfig();
  const userAuth = options.userAuth ?? userAuthConfig();
  const limits = options.rateLimits ?? rateLimitConfig();
  const app = Fastify({ logger: options.logger ?? false, trustProxy: trustedProxies(), ajv: { customOptions: { coerceTypes: false, removeAdditional: false } } });
  const queue = options.queue ?? createDocumentQueue();
  app.addHook("onClose", async () => queue.close());
  configureCommon(app);
  app.register(cors, {
    // 管理端与用户端只对各自配置的来源允许携带 Cookie；其他来源仍可无状态地调用公开接口。
    delegator: async (request: FastifyRequest) => request.url.startsWith("/api/admin/")
      ? { origin: auth.origins, credentials: true, exposedHeaders: ["Retry-After"], allowedHeaders: ["Content-Type", "X-NYZ-Admin"], methods: ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"] }
      : userAuth.origins.includes(request.headers.origin ?? "")
        ? { origin: userAuth.origins, credentials: true, exposedHeaders: ["Retry-After"], allowedHeaders: ["Content-Type", "X-NYZ-Client"], methods: ["GET", "HEAD", "POST", "DELETE", "OPTIONS"] }
        : { origin: true, credentials: false, exposedHeaders: ["Retry-After"] },
  });
  app.after(() => {
    configureRateLimits(app, options.limiter ?? createRedisAdmissionLimiter(), limits);
    configureAdminAuth(app, auth, options.authStore ?? createAdminAuthStore(), options.admins ?? databaseAdmins);
    configureUserAuth(app, {
      config: userAuth,
      store: options.userAuthStore ?? createAuthStore("user-auth"),
      mailer: options.mailer === undefined ? createMailer(app.log) : options.mailer,
      users: options.users ?? databaseUsers,
    });
  });
  app.register(commonRoutes);
  app.register(chatRoutes);
  app.register(searchRoutes);
  app.register(documentRoutes, { queue });
  app.register(dataSourceRoutes);
  app.register(crawlTaskRoutes, { queue });
  app.register(knowledgeBaseRoutes);
  app.register(modelProviderRoutes);
  app.register(settingRoutes);
  app.register(userRoutes);
  app.register(adminAccountRoutes, { admins: options.admins ?? databaseAdmins });
  return app;
}
