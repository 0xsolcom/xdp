#!/usr/bin/env bash
# 后台启动采集调度（链上直采 + 成交 WS + 定时任务 + 排行刷新），日志写 logs/index.log
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
PIDFILE=logs/index.pid

# ① pid 文件说在跑 → 直接退出
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
  echo "已在运行，PID $(cat "$PIDFILE")"
  exit 0
fi

# ② pid 文件丢了/过期了，但本目录其实还有采集进程在跑
#    → 把 pid 写回去并在退出，**不要**再起一个（两个采集器同时写库会把 RPC 打爆、
#      数据还会互相打架；这种情况实际发生过）。
#    只按 /proc 里的 cwd + cmdline 找，绝不 pkill。
find_stray() {
  local p
  for p in $(pgrep -f 'src/index\.js' 2>/dev/null); do
    [ "$p" = "$$" ] && continue
    if [ "$(readlink "/proc/$p/cwd" 2>/dev/null)" = "$(pwd)" ]; then echo "$p"; return 0; fi
  done
  return 1
}
STRAY=$(find_stray || true)
if [ -n "$STRAY" ]; then
  echo "$STRAY" > "$PIDFILE"
  echo "⚠️  发现本目录已有采集进程在跑（PID $STRAY），但 pid 文件丢了 —— 已写回 $PIDFILE"
  echo "    没有重复启动。要重启请先：./stop.sh"
  exit 1
fi

nohup node src/index.js >> logs/index.log 2>&1 &
echo $! > "$PIDFILE"
echo "已启动，PID $(cat "$PIDFILE")  日志: logs/index.log"
echo "实时看日志: tail -f logs/index.log"
echo "看链上实时通道: tail -f logs/index.log | grep 链上"
