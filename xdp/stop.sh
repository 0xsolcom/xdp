#!/usr/bin/env bash
# 停止采集调度
#
# ⚠️ 绝不按名字 pkill。
#    老版本在 pid 文件缺失时会跑 `pkill -f "node src/index.js"` ——
#    同机上任何别的项目只要也叫 src/index.js 就会被一起杀掉（已实际发生过）。
#    而且 pid 文件缺失时它什么都不做，导致「进程还活着但已经没人管」的残留。
#
# 三道保险：
#   ① 只认 pid 文件，不猜、不扫、不按名字杀
#   ② 杀之前核对 /proc/<pid>/cwd 与 cmdline —— pid 被系统复用成别的进程时不会误杀
#   ③ 进程已经不在 → 清掉残留 pid 文件并明确退出码
cd "$(dirname "$0")"
PIDFILE=logs/index.pid

if [ ! -f "$PIDFILE" ]; then
  echo "没有 $PIDFILE（未启动？）"
  echo "  若确定有采集在跑，用这条找出来：ps -eo pid,lstart,cmd | grep '[s]rc/index.js'"
  exit 1
fi

PID=$(cat "$PIDFILE" 2>/dev/null | tr -d '[:space:]')
if [ -z "$PID" ]; then
  echo "⚠️  $PIDFILE 是空的，清理掉"
  rm -f "$PIDFILE"
  exit 1
fi

if ! kill -0 "$PID" 2>/dev/null; then
  echo "PID $PID 不存在（残留 pid 文件），清理掉"
  rm -f "$PIDFILE"
  exit 0
fi

# 核身：确认这个 pid 真的是「本目录的 node src/index.js」
CMDLINE=$(tr '\0' ' ' < "/proc/$PID/cmdline" 2>/dev/null)
CWD=$(readlink "/proc/$PID/cwd" 2>/dev/null)
if [ "$CWD" != "$(pwd)" ] || [[ "$CMDLINE" != *"src/index.js"* ]]; then
  echo "⚠️  PID $PID 不是本目录的采集进程，不动它（只清理 pid 文件）"
  echo "    cwd=$CWD  cmd=$CMDLINE"
  rm -f "$PIDFILE"
  exit 1
fi

kill "$PID" 2>/dev/null || true
for _ in $(seq 1 20); do
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.5
done
if kill -0 "$PID" 2>/dev/null; then
  kill -9 "$PID" 2>/dev/null || true
  sleep 1
fi
rm -f "$PIDFILE"
echo "⏹  已停止 PID $PID"
