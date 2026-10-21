#!/usr/bin/env bash
# 本地启动水电费账单服务（不用 Docker、不用 npm install）
#
# 用法：
#   ./scripts/start.sh                 # 默认 0.0.0.0:8787
#   PORT=9000 ./scripts/start.sh       # 换端口
#   HOST=127.0.0.1 ./scripts/start.sh  # 只允许本机访问
#   NODE_BIN=/path/to/node ./scripts/start.sh  # 指定 node
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$BASE_DIR"

DATA_DIR="${DATA_DIR:-$BASE_DIR/data}"
LOG_FILE="${LOG_FILE:-$DATA_DIR/server.log}"
PID_FILE="${PID_FILE:-$DATA_DIR/server.pid}"
PORT="${PORT:-8787}"
HOST="${HOST:-0.0.0.0}"
DB_PATH="${DB_PATH:-$DATA_DIR/billing.db}"

# 找 node：cron / 非登录 shell 的 PATH 里可能没有 Node 应用目录
NODE_BIN="${NODE_BIN:-}"
if [ -z "$NODE_BIN" ]; then
  for candidate in "$(command -v node 2>/dev/null || true)" \
                   /var/apps/nodejs_v24/target/bin/node \
                   /usr/local/bin/node /usr/bin/node; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then NODE_BIN="$candidate"; break; fi
  done
fi
if [ -z "$NODE_BIN" ]; then
  echo "错误：找不到 node，可用 NODE_BIN=/path/to/node ./scripts/start.sh 指定" >&2
  exit 1
fi

mkdir -p "$DATA_DIR"
touch "$LOG_FILE"

is_running() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

health_ok() {
  command -v curl >/dev/null 2>&1 && curl -fsS --max-time 1 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1
}

if is_running; then
  echo "已在运行（PID $(cat "$PID_FILE")）：http://localhost:$PORT"
  exit 0
fi

if health_ok; then
  echo "端口 $PORT 上已有服务在响应 /api/health，但 PID 文件缺失。" >&2
  echo "可能是上次没正常停止，请先执行 scripts/stop.sh，或手动结束占用该端口的进程。" >&2
  exit 1
fi

echo "[$(date '+%F %T')] ---- 启动服务 (port=$PORT) ----" >> "$LOG_FILE"
setsid env PORT="$PORT" HOST="$HOST" DB_PATH="$DB_PATH" NODE_ENV=production \
  "$NODE_BIN" "$BASE_DIR/app/server.js" >> "$LOG_FILE" 2>&1 < /dev/null &
echo $! > "$PID_FILE"

# 若 setsid 自行 fork 过，按命令行兜底找回真实 PID
PID="$(cat "$PID_FILE")"
if ! ps -o cmd= -p "$PID" 2>/dev/null | grep -q "app/server.js"; then
  FOUND="$(pgrep -f "$BASE_DIR/app/server.js" 2>/dev/null | head -1 || true)"
  if [ -n "$FOUND" ]; then
    PID="$FOUND"
    echo "$PID" > "$PID_FILE"
  fi
fi

for _ in $(seq 1 40); do
  if health_ok; then
    LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
    echo "启动成功（PID $PID）"
    echo "  本机访问：http://localhost:$PORT"
    [ -n "$LAN_IP" ] && echo "  局域网访问：http://$LAN_IP:$PORT"
    echo "  数据库：$DB_PATH"
    echo "  日志：$LOG_FILE"
    exit 0
  fi
  sleep 0.25
done

echo "启动失败，最近日志：" >&2
tail -n 30 "$LOG_FILE" >&2 || true
exit 1
