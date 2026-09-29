#!/usr/bin/env bash
# 后台启动采集调度（实时 + 回溯 + 合约检测 + 排行刷新），日志写 logs/index.log
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "❌ 未找到 node，请先安装 Node.js 18+" >&2
  exit 1
fi
if [ ! -f src/index.js ]; then
  echo "❌ 找不到 src/index.js，请在 xdp 目录下执行 ./start.sh" >&2
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "❌ 缺少依赖 node_modules。请先执行：npm install" >&2
  exit 1
fi

mkdir -p logs
if [ -f logs/index.pid ] && kill -0 "$(cat logs/index.pid)" 2>/dev/null; then
  echo "已在运行，PID $(cat logs/index.pid)"
  exit 0
fi
nohup node src/index.js >> logs/index.log 2>&1 &
echo $! > logs/index.pid
echo "已启动，PID $(cat logs/index.pid)  日志: logs/index.log"
echo "实时看日志: tail -f logs/index.log"
echo "看链上实时通道: tail -f logs/index.log | grep 链上"
