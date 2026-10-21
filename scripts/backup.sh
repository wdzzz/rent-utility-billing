#!/usr/bin/env bash
# 备份数据库（一致性快照），默认保存到 data/backups，保留最近 30 份
# 优先在运行中的容器里执行 VACUUM INTO；容器没跑时退回宿主机 node
# 用法：./scripts/backup.sh
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$BASE_DIR"
DATA_DIR="${DATA_DIR:-$BASE_DIR/data}"
DB_PATH="${DB_PATH:-$DATA_DIR/billing.db}"
BACKUP_DIR="${BACKUP_DIR:-$DATA_DIR/backups}"
KEEP="${KEEP:-30}"

mkdir -p "$BACKUP_DIR"
STAMP="$(date '+%Y%m%d-%H%M%S')"
TARGET="$BACKUP_DIR/billing-$STAMP.db"

container_running() {
  command -v docker >/dev/null 2>&1 &&
    docker compose ps --status running -q 2>/dev/null | grep -q .
}

if container_running; then
  # 在容器里备份到 /data/backups，宿主机 ./data/backups 直接可见
  docker compose exec -T billing node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/data/billing.db', { readOnly: false });
db.exec(\"VACUUM INTO '/data/backups/billing-$STAMP.db'\");
db.close();
"
else
  if [ ! -f "$DB_PATH" ]; then
    echo "错误：数据库不存在：$DB_PATH" >&2
    exit 1
  fi
  NODE_BIN="${NODE_BIN:-}"
  if [ -z "$NODE_BIN" ]; then
    for candidate in "$(command -v node 2>/dev/null || true)" \
                     /var/apps/nodejs_v24/target/bin/node \
                     /usr/local/bin/node /usr/bin/node; do
      if [ -n "$candidate" ] && [ -x "$candidate" ]; then NODE_BIN="$candidate"; break; fi
    done
  fi
  if [ -n "$NODE_BIN" ] && "$NODE_BIN" -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1], { readOnly: false });
db.exec(\"VACUUM INTO '\" + process.argv[2].replace(/'/g, \"''\") + \"'\");
db.close();
" "$DB_PATH" "$TARGET" 2>/dev/null; then
    :
  else
    echo "提示：VACUUM INTO 不可用，改为直接复制（建议先停服务）" >&2
    cp "$DB_PATH" "$TARGET"
    [ -f "$DB_PATH-wal" ] && cp "$DB_PATH-wal" "$TARGET-wal" 2>/dev/null || true
    [ -f "$DB_PATH-shm" ] && cp "$DB_PATH-shm" "$TARGET-shm" 2>/dev/null || true
  fi
fi

echo "已备份：$TARGET ($(du -h "$TARGET" 2>/dev/null | cut -f1 || echo '?'))"

# 只保留最近 N 份
COUNT="$(ls -1 "$BACKUP_DIR"/billing-*.db 2>/dev/null | wc -l)"
if [ "$COUNT" -gt "$KEEP" ]; then
  ls -1t "$BACKUP_DIR"/billing-*.db | tail -n +$((KEEP + 1)) | while read -r old; do
    rm -f "$old" "$old-wal" "$old-shm"
  done
  echo "已清理旧备份，保留最近 $KEEP 份"
fi
