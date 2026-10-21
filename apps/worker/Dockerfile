FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/worker/package.json apps/worker/package.json
RUN pnpm install --frozen-lockfile
COPY apps/worker apps/worker
RUN pnpm --filter @nyz-rag/worker build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY --from=build /app ./
CMD ["pnpm", "--filter", "@nyz-rag/worker", "start"]
