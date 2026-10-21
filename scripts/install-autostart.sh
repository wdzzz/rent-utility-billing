#!/usr/bin/env bash
# 可选：开机自启 + 容器存活检查（用户级 crontab）
# 依赖：Docker 服务本身已开机启动；不想要了执行 ./scripts/uninstall-autostart.sh
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
START_CMD="cd '$BASE_DIR' && ./scripts/start.sh >/dev/null 2>&1"
WATCH_CMD="cd '$BASE_DIR' && ./scripts/start.sh >/dev/null 2>&1"
MARK="# rent-utility-billing autostart"

if ! command -v crontab >/dev/null 2>&1; then
  echo "错误：系统没有 crontab，无法安装开机自启" >&2
  exit 1
fi

CURRENT="$(crontab -l 2>/dev/null || true)"
if echo "$CURRENT" | grep -qF "$MARK"; then
  echo "已经安装过开机自启："
  echo "$CURRENT" | grep -F "$MARK"
  exit 0
fi

{
  echo "$CURRENT"
  echo "@reboot $START_CMD $MARK"
  echo "*/5 * * * * $WATCH_CMD # rent-utility-billing watchdog"
} | sed '/^$/d' | crontab -

echo "已安装开机自启 + 每 5 分钟容器存活检查："
crontab -l | tail -n 2
echo
echo "提示：cron 需要在运行；Docker 服务本身也要开机启动（NAS 上一般默认）。"
echo "     如果只想开机启动、不要守护，可 crontab -e 删掉第二行。"
