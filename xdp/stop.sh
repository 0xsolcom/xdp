#!/usr/bin/env bash
# 停止采集调度
cd "$(dirname "$0")"
if [ -f logs/index.pid ]; then
  PID=$(cat logs/index.pid)
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID"
    sleep 1
    kill -9 "$PID" 2>/dev/null || true
    echo "已停止 PID $PID"
  else
    echo "进程不存在"
  fi
  rm -f logs/index.pid
else
  pkill -f "node src/index.js" && echo "已按名字停止" || echo "没有在跑"
fi
