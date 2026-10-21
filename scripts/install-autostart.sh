#!/usr/bin/env bash
# 可选：开机自启（用户级 crontab @reboot）
# 不想要了执行 ./scripts/uninstall-autostart.sh
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
START_CMD="cd '$BASE_DIR' && ./scripts/start.sh >/dev/null 2>&1"
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
  echo "*/5 * * * * pgrep -f '$BASE_DIR/app/server.js' >/dev/null 2>&1 || $START_CMD # rent-utility-billing watchdog"
} | sed '/^$/d' | crontab -

echo "已安装开机自启 + 每 5 分钟存活检查："
crontab -l | tail -n 2
echo
echo "提示：cron 需要在运行（本机 /usr/sbin/cron 已在运行）。"
echo "     如果只想开机启动、不要守护，可手动编辑 crontab -e 删掉第二行。"
