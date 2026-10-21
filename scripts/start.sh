#!/usr/bin/env bash
# 用 Docker Compose 启动水电费账单服务
#
# 用法：
#   ./scripts/start.sh                  # 后台启动（默认 8787 端口）
#   PORT=9000 ./scripts/start.sh        # 换端口（同时改 .env 或环境变量）
#   docker compose up -d --build        # 重建镜像
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$BASE_DIR"

PORT="${PORT:-$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 || true)}"
PORT="${PORT:-8787}"

if ! command -v docker >/dev/null 2>&1; then
  echo "错误：没有安装 docker（或不在 PATH 里）" >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "错误：需要 Docker Compose v2（docker compose 命令）" >&2
  exit 1
fi

docker compose up -d --remove-orphans

health_ok() {
  curl -fsS --max-time 1 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1
}

for _ in $(seq 1 60); do
  if health_ok; then
    LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
    echo "启动成功（Docker 容器 rent-utility-billing）"
    echo "  本机访问：http://localhost:$PORT"
    [ -n "$LAN_IP" ] && echo "  局域网访问：http://$LAN_IP:$PORT"
    echo "  数据目录：$BASE_DIR/data（容器内 /data）"
    echo "  查看日志：docker compose logs -f"
    exit 0
  fi
  sleep 0.5
done

echo "启动失败，最近日志：" >&2
docker compose logs --tail=40 >&2 || true
exit 1
