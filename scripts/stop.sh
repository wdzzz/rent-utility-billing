#!/usr/bin/env bash
# 停止本地水电费账单服务
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${DATA_DIR:-$BASE_DIR/data}"
PID_FILE="${PID_FILE:-$DATA_DIR/server.pid}"
PORT="${PORT:-8787}"

stopped=0

if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.25
    done
    if kill -0 "$PID" 2>/dev/null; then
      echo "进程 $PID 未在 5 秒内退出，强制结束"
      kill -9 "$PID" 2>/dev/null || true
    fi
    stopped=1
  fi
  rm -f "$PID_FILE"
fi

# 兜底：按绝对路径匹配本项目的服务进程
OTHERS="$(pgrep -f "$BASE_DIR/app/server.js" 2>/dev/null || true)"
if [ -n "$OTHERS" ]; then
  echo "清理残留进程：$OTHERS"
  # shellcheck disable=SC2086
  kill $OTHERS 2>/dev/null || true
  sleep 0.5
  OTHERS="$(pgrep -f "$BASE_DIR/app/server.js" 2>/dev/null || true)"
  [ -n "$OTHERS" ] && kill -9 $OTHERS 2>/dev/null || true
  stopped=1
fi

if [ "$stopped" = "1" ]; then
  echo "服务已停止"
else
  echo "服务本来就没有在运行"
fi

if command -v curl >/dev/null 2>&1 && curl -fsS --max-time 1 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  echo "警告：端口 $PORT 仍有服务响应 /api/health，可能被其他程序占用" >&2
  exit 1
fi
