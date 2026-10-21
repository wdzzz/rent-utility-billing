#!/bin/sh
# 以 root 启动时修正数据目录属主，然后降权到 node 用户运行，
# 这样宿主机的 ./data 挂载目录不需要手工 chown。
set -e

if [ "$(id -u)" = "0" ]; then
  DATA_DIR="$(dirname "${DB_PATH:-/data/billing.db}")"
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR" 2>/dev/null || \
    echo "[entrypoint] 警告：无法修改 $DATA_DIR 的属主，继续以 node 用户运行" >&2
  exec su-exec node:node "$@"
fi

exec "$@"
