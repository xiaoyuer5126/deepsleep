# syntax=docker/dockerfile:1

# 基础镜像与 npm 源都可覆盖：
#   docker build --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:24-bookworm-slim .
#   docker build --build-arg NPM_REGISTRY=https://registry.npmjs.org .
ARG NODE_IMAGE=node:24-bookworm-slim
# 默认使用国内 npmmirror（淘宝）npm 镜像；海外或镜像不可用时改成 https://registry.npmjs.org
ARG NPM_REGISTRY=https://registry.npmmirror.com

# ---------- 前端构建 ----------
FROM ${NODE_IMAGE} AS web
ARG NPM_REGISTRY

WORKDIR /app/web
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    npm install -g pnpm@10 --registry=${NPM_REGISTRY} \
    && pnpm config set registry ${NPM_REGISTRY}
COPY web/package.json web/pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --reporter=silent
COPY web/ ./
RUN pnpm build

# ---------- 后端依赖 ----------
FROM ${NODE_IMAGE} AS server-deps
ARG NPM_REGISTRY

WORKDIR /app/server
COPY server/package.json ./
RUN --mount=type=cache,id=npm-cache,target=/root/.npm \
    npm install --omit=dev --no-audit --no-fund --registry=${NPM_REGISTRY}

# ---------- 测试（可选目标：docker build --target test）----------
FROM server-deps AS test
WORKDIR /app/server
COPY server/ ./
# 显式指定测试文件：test/ 目录下的 mock-server.mjs 是常驻 mock 服务，不能让 --test 自动发现
CMD ["node", "--test", "test/e2e.test.js"]

# ---------- 运行时 ----------
FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production \
    PORT=3080 \
    DATA_DIR=/data \
    WEB_DIST=/app/web/dist \
    TZ=Asia/Shanghai \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

WORKDIR /app
COPY --from=server-deps /app/server/node_modules ./server/node_modules
COPY server/ ./server/
COPY --from=web /app/web/dist ./web/dist
COPY web/LICENSE ./web/LICENSE

RUN chmod +x /app/server/docker-entrypoint.sh \
    && mkdir -p /data \
    && chown -R node:node /data \
    && chmod -R a+rX /app

VOLUME ["/data"]
EXPOSE 3080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 入口脚本修正数据目录权限后降权到 node 用户运行
ENTRYPOINT ["/bin/sh", "/app/server/docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
