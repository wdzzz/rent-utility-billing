#!/usr/bin/env bash
# 查看本地水电费账单服务状态
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${DATA_DIR:-$BASE_DIR/data}"
PID_FILE="${PID_FILE:-$DATA_DIR/server.pid}"
LOG_FILE="${LOG_FILE:-$DATA_DIR/server.log}"
PORT="${PORT:-8787}"

echo "目录：$BASE_DIR"
echo "端口：$PORT"

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null; then
  PID="$(cat "$PID_FILE")"
  echo "进程：运行中 (PID $PID)"
  ps -o pid,etime,rss,cmd -p "$PID" 2>/dev/null | tail -n +2 || true
else
  echo "进程：未运行（无有效 PID 文件或进程已退出）"
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

echo "日志（最后 10 行）：$LOG_FILE"
if [ -f "$LOG_FILE" ]; then
  tail -n 10 "$LOG_FILE" || true
else
  echo "  （暂无日志）"
fi
