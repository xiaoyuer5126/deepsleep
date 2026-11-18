# syntax=docker/dockerfile:1

# 浏览器冒烟测试镜像：headless Chromium + puppeteer-core。
# 构建：docker build -t dsw-e2e tools/e2e
# 运行：docker run --rm --network dpsk-self_default -e TARGET_URL=http://deepseek-web-test:3080 \
#         -v "$PWD/docs/screenshots:/shots" dsw-e2e
ARG NODE_IMAGE=node:24-bookworm-slim
# 国内 apt / npm 镜像，可覆盖
ARG APT_MIRROR=mirrors.tuna.tsinghua.edu.cn
ARG NPM_REGISTRY=https://registry.npmmirror.com

FROM ${NODE_IMAGE}
ARG APT_MIRROR
ARG NPM_REGISTRY

RUN sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update -qq \
    && apt-get install -y -qq chromium fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /e2e
COPY package.json ./
RUN --mount=type=cache,id=npm-cache,target=/root/.npm \
    npm install --no-audit --no-fund --registry=${NPM_REGISTRY}
COPY smoke.mjs render-icon.mjs ./

ENV TARGET_URL=http://deepseek-web-test:3080 \
    SHOTS_DIR=/shots
CMD ["node", "smoke.mjs"]
