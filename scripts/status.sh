#!/usr/bin/env bash
# 查看水电费账单服务（Docker）状态
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$BASE_DIR"
DATA_DIR="${DATA_DIR:-$BASE_DIR/data}"
PORT="${PORT:-$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 || true)}"
PORT="${PORT:-8787}"

echo "目录：$BASE_DIR"
echo "端口：$PORT"

if command -v docker >/dev/null 2>&1; then
  echo "容器："
  docker compose ps 2>/dev/null || echo "  （docker compose 不可用）"
else
  echo "容器：未安装 docker"
fi

if command -v curl >/dev/null 2>&1; then
  echo -n "健康检查："
  if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/health"; then
    echo
  else
    echo "失败（服务未响应）"
  fi
fi

echo "数据库：$DATA_DIR/billing.db"
if [ -f "$DATA_DIR/billing.db" ]; then
  echo "  大小：$(du -h "$DATA_DIR/billing.db" | cut -f1)"
fi

echo "容器日志（最后 10 行）："
docker compose logs --tail=10 2>/dev/null || echo "  （暂无日志/未启动）"
