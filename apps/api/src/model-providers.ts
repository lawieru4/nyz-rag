import type { FastifyPluginAsync } from "fastify";
import { createModelProvider, deleteModelProvider, listModelProviders, updateModelProvider } from "@nyz-rag/processing";
import type { SaveModelProviderRequest } from "@nyz-rag/types";

function validBaseUrl(url: string) {
  if (!url) return true;
  try { return ["http:", "https:"].includes(new URL(url).protocol); }
  catch { return false; }
}

export const modelProviderRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/admin/model-providers", async () => listModelProviders());

  app.post<{ Body: SaveModelProviderRequest }>("/api/admin/model-providers", async (request, reply) => {
    if (!validBaseUrl(request.body.baseUrl)) return reply.code(400).send({ error: "baseUrl must be a valid http(s) URL" });
    return reply.code(201).send(await createModelProvider({ ...request.body, name: request.body.name.trim() }));
  });

  app.patch<{ Params: { id: string }; Body: SaveModelProviderRequest }>("/api/admin/model-providers/:id", async (request, reply) => {
    if (!validBaseUrl(request.body.baseUrl)) return reply.code(400).send({ error: "baseUrl must be a valid http(s) URL" });
    const updated = await updateModelProvider(request.params.id, { ...request.body, name: request.body.name.trim() });
    if (!updated) return reply.code(404).send({ error: "model provider not found" });
    return updated;
  });

  app.delete<{ Params: { id: string } }>("/api/admin/model-providers/:id", async (request, reply) => {
    if (!await deleteModelProvider(request.params.id)) return reply.code(404).send({ error: "model provider not found" });
    return reply.code(204).send();
  });
};
