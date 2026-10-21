# Repository Instructions

- This is a pnpm workspace (`apps/*`, `packages/*`); shared frontend/API contracts live in `packages/types` and are imported as `@nyz-rag/types`.
- `apps/web` and `apps/admin` are separate Vue 3/Vite applications; `apps/api` is the Fastify entrypoint and `apps/worker` consumes the BullMQ `document-processing` queue.
- Root commands: `pnpm dev` starts API, web, and worker (not admin); `pnpm build` builds all workspace packages; `pnpm typecheck` typechecks all packages.
- Focused commands: `pnpm --filter @nyz-rag/<api|web|admin|worker|types> dev|build|typecheck`. API and worker use `tsx watch`; Vue apps use Vite and `vue-tsc`.
- Local API/worker development expects Redis at `REDIS_URL` (default `redis://localhost:6379`). Start local infrastructure with `docker compose up -d`; Compose also provides PostgreSQL with pgvector, though the current API store is JSON-backed.
- `.env` is gitignored; `.env.example` documents the local environment. Vite reads `VITE_API_URL` for the client API endpoint.
- The current knowledge store is `apps/api/.nyz-data/knowledge.json` by default for the API; the worker default path is relative to its package (`../../.nyz-data/knowledge.json`). Set `NYZ_STORE_PATH` consistently when changing this during local runs.
- No test or lint scripts/CI workflows are currently defined. Use `pnpm typecheck` and `pnpm build` for available verification.
