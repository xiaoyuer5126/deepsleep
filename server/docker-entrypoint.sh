#!/bin/sh
# 容器以 root 启动：先把数据目录交给 node 用户（宿主机 bind mount 常见为 root 所有），
# 再降权到 node 运行应用，避免 Linux 上 ./data 不可写导致启动失败。
set -e

DATA_DIR="${DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR" 2>/dev/null || true
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi

exec "$@"
