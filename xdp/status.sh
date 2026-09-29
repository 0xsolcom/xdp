#!/usr/bin/env bash
# 查看运行状态与抓取统计
cd "$(dirname "$0")"
echo "==================== 进程 ===================="
if [ -f logs/index.pid ] && kill -0 "$(cat logs/index.pid)" 2>/dev/null; then
  echo "运行中 PID $(cat logs/index.pid)"
else
  pgrep -fl "node src/index.js" || echo "未运行"
fi
echo
echo "==================== 统计 ===================="
if [ ! -d node_modules ]; then
  echo "❌ 缺少依赖 node_modules，请先执行：npm install"
  exit 1
fi
node scripts/status.js
