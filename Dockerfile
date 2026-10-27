FROM node:24-alpine AS build
WORKDIR /app
RUN npm install --global pnpm@12.11.2
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps ./apps
COPY packages ./packages
ENV VITE_API_URL=""
# 微信小程序不进镜像：只安装、构建 apps 与 packages 中除 weixin 外的包（不选根包，其 build 脚本会递归到全部包）。
RUN pnpm install --frozen-lockfile --filter "./apps/**" --filter "./packages/**" --filter "!@nyz-rag/weixin" \
  && pnpm -r --filter "./apps/**" --filter "./packages/**" --filter "!@nyz-rag/weixin" build

FROM node:24-alpine AS backend
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app /app
COPY docker/start.mjs /app/docker/start.mjs
USER node
ENTRYPOINT ["node", "/app/docker/start.mjs"]

FROM backend AS api
EXPOSE 3000
CMD ["apps/api/dist/index.js"]

FROM backend AS worker
CMD ["apps/worker/dist/index.js"]

FROM nginxinc/nginx-unprivileged:stable-alpine AS frontend
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1

FROM frontend AS web
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

FROM frontend AS admin
COPY --from=build /app/apps/admin/dist /usr/share/nginx/html
