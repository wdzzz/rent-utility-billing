#!/usr/bin/env bash
# 移除开机自启 / 守护 cron 条目
set -euo pipefail

CURRENT="$(crontab -l 2>/dev/null || true)"
if ! echo "$CURRENT" | grep -q "rent-utility-billing"; then
  echo "没有找到自启条目"
  exit 0
fi

echo "$CURRENT" | grep -v "rent-utility-billing" | sed '/^$/d' | crontab -
echo "已移除开机自启条目。当前 crontab："
crontab -l 2>/dev/null || echo "（空）"
