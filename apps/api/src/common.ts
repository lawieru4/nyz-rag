/**
 * common.ts — Shared utilities and Fastify infrastructure for the API.
 *
 * ## configureCommon(app)
 *
 * Registers:
 *  1. `onRoute` hook — attaches JSON Schema (body/querystring/params/response)
 *     from the schemas.ts registry to every matching route. Routes not in the
 *     registry are skipped (e.g. CORS preflight, plugin-internal routes).
 *  2. Global `setErrorHandler` — normalises all errors to `{ error: string }`,
 *     never leaking internal details for unexpected 500s.
 *  3. `setNotFoundHandler` — uniform 404 `{ error: "not found" }`.
 *
 * ## Expected Fastify / AJV settings
 *
 * Create the Fastify instance with:
 *
 * ```ts
 * const app = Fastify({
 *   logger: true,
 *   ajv: {
 *     customOptions: {
 *       coerceTypes: false,   // no silent number/string coercion
 *       allErrors: false,     // stop at first validation error
 *       removeAdditional: false, // schemas use additionalProperties:false instead
 *     },
 *   },
 * });
 * ```
 *
 * With `coerceTypes: false` query-string values arrive as plain strings
 * (Fastify's default parser). Pagination query-string fields use a
 * `"^[1-9][0-9]*$"` pattern so they validate cleanly without coercion, and
 * `pageParams()` converts them to numbers.
 *
 * ## commonRoutes
 *
 * A FastifyPluginAsync that registers infrastructure routes that belong at the
 * root level and do NOT depend on a BullMQ queue:
 *  - GET /health
 *  - GET /api/knowledge
 *  - GET /api/admin/knowledge (authenticated operational overview)
 */

import type { FastifyError, FastifyInstance, FastifyPluginAsync } from "fastify";
import { getStats, listSources, listTasks } from "@nyz-rag/processing";
import { routeSchemas } from "./schemas.js";

// ─── Re-exported utilities (preserve existing public API) ─────────────────────

export const MAX_QUESTION_LENGTH = 2000;

export const elapsed = (start: number) => Math.round(performance.now() - start);

export const pageParams = (page: string, pageSize: string) => ({
  page: Math.max(1, Number.parseInt(page, 10) || 1),
  pageSize: Math.min(100, Math.max(1, Number.parseInt(pageSize, 10) || 20)),
});

// ─── configureCommon ──────────────────────────────────────────────────────────

/**
 * Install the schema hook, unified error handler, and 404 handler.
 * Call this ONCE on the root Fastify instance, before registering plugins.
 *
 * Expected Fastify instance options:
 *   ajv.customOptions.coerceTypes = false
 *   ajv.customOptions.removeAdditional = false
 */
export function configureCommon(app: FastifyInstance): void {
  // 1. Attach schemas to matching routes via onRoute hook.
  //    Registered at the root scope so the hook fires for all plugins.
  app.addHook("onRoute", (routeOptions) => {
    // method can be an array (e.g. HEAD + GET); normalise to the primary string.
    const method = Array.isArray(routeOptions.method)
      ? routeOptions.method[0]
      : routeOptions.method;
    const key = `${method} ${routeOptions.url}`;
    const schema = routeSchemas[key];
    if (!schema) return;

    // Merge so that a route's own explicit schema keys win over the registry.
    routeOptions.schema = {
      ...schema,
      ...routeOptions.schema,
    };
  });

  // 2. Unified error handler.
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    // Fastify validation errors (AJV) carry a statusCode of 400 and a validation array.
    if (error.validation) {
      const messages = (error.validation as Array<{ message?: string }>)
        .map((v) => v.message ?? "invalid value")
        .join("; ");
      return reply.code(400).send({ error: `Validation failed: ${messages}` });
    }

    // Client errors carry a 4xx statusCode (e.g. FST_ERR_CTP_INVALID_JSON_BODY for malformed JSON);
    // errors without one (including SyntaxErrors thrown by handlers) are 500s.
    const status = error.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      return reply.code(status).send({ error: error.message || "Bad request" });
    }

    // Unexpected server errors — log but never leak internals.
    reply.log.error(error);
    return reply.code(500).send({ error: "Internal server error" });
  });

  // 3. 404 handler.
  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: "not found" });
  });
}

// ─── commonRoutes ─────────────────────────────────────────────────────────────

/**
 * Registers infrastructure routes that belong at the root level and do not
 * require a document queue:
 *  - GET /health
 *  - GET /api/knowledge
 *  - GET /api/admin/knowledge
 */
export const commonRoutes: FastifyPluginAsync = async (app) => {
  app.get("/health", async () => ({
    status: "ok",
    service: "nyz-rag-api",
    timestamp: new Date().toISOString(),
  }));

  app.get("/api/knowledge", async () => {
    return { stats: await getStats() };
  });

  app.get("/api/admin/knowledge", async () => {
    const [sources, tasks, stats] = await Promise.all([listSources(), listTasks(), getStats()]);
    return { sources, tasks, stats };
  });
};
