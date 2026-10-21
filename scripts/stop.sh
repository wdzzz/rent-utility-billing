#!/usr/bin/env bash
# 停止并移除水电费账单服务的 Docker 容器（数据保留在 ./data）
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$BASE_DIR"

PORT="${PORT:-$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 || true)}"
PORT="${PORT:-8787}"

if ! command -v docker >/dev/null 2>&1; then
  echo "错误：没有安装 docker" >&2
  exit 1
fi

docker compose down

if command -v curl >/dev/null 2>&1 && curl -fsS --max-time 1 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  echo "警告：端口 $PORT 仍有服务响应 /api/health，可能被其他程序占用（比如旧的 node 进程）" >&2
  exit 1
fi

echo "服务已停止（数据仍在 $BASE_DIR/data）"
