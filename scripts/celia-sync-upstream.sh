#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────────
# celia-sync-upstream.sh
#
# 一键同步 openclaw 上游到我们的 fork：
#   1. fetch upstream
#   2. main 镜像 upstream/main 并推到 fork
#   3. celia rebase 到最新 upstream/main
#   4. 强推 celia（--force-with-lease）
#
# 冲突时脚本会停下，让用户手动解冲突后再 git rebase --continue。
# ────────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")/.."

# 颜色
C_BLUE="\033[34m"
C_GREEN="\033[32m"
C_YELLOW="\033[33m"
C_RED="\033[31m"
C_RESET="\033[0m"

log() { echo -e "${C_BLUE}[sync]${C_RESET} $*"; }
ok()  { echo -e "${C_GREEN}[ok]${C_RESET}  $*"; }
warn(){ echo -e "${C_YELLOW}[warn]${C_RESET} $*"; }
err() { echo -e "${C_RED}[err]${C_RESET} $*" >&2; }

# 前置检查
log "检查 remote 配置..."
if ! git remote get-url upstream >/dev/null 2>&1; then
  err "remote 'upstream' 不存在。请先运行："
  err "  git remote add upstream https://github.com/openclaw/openclaw.git"
  exit 1
fi
if ! git remote get-url origin | grep -q "xingguo0127/openclaw"; then
  warn "origin 不是指向 xingguo0127/openclaw —— 请确认是否在正确的 fork 仓库"
fi

# 检查工作区干净
if ! git diff --quiet || ! git diff --cached --quiet; then
  err "工作区有未提交改动，请先 stash 或 commit"
  git status --short
  exit 1
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)

# 1. fetch upstream
log "fetch upstream..."
git fetch upstream

# 2. main 镜像 upstream/main
log "同步 main ← upstream/main..."
git checkout main
git reset --hard upstream/main
log "推送 main 到 fork..."
git push origin main --force-with-lease
ok "main 已同步"

# 3. celia rebase 到 upstream/main
log "rebase celia on upstream/main..."
git checkout celia
if git rebase upstream/main; then
  ok "celia rebase 无冲突"
else
  err "rebase 冲突！请手动解决冲突："
  err "  1) 编辑冲突文件"
  err "  2) git add <文件>"
  err "  3) git rebase --continue"
  err "解决完成后再手动 git push origin celia --force-with-lease"
  exit 2
fi

# 4. 强推 celia
log "推送 celia 到 fork..."
git push origin celia --force-with-lease
ok "celia 已同步"

# 恢复初始分支
if [[ "$CURRENT_BRANCH" != "celia" && "$CURRENT_BRANCH" != "main" ]]; then
  log "切回初始分支 $CURRENT_BRANCH..."
  git checkout "$CURRENT_BRANCH"
fi

ok "全部同步完成 🎉"
echo ""
echo "本次 celia 基于 upstream:"
git log --oneline -5 celia
