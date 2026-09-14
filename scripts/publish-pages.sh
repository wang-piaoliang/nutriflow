#!/usr/bin/env bash
set -euo pipefail

# 这个仓库以前有两个 remote，脚本里写死了 `github`。现在只剩 `origin`，
# 写死的那个名字让整个脚本第一步就挂（用户那边一直是手工发布的）。
# 有 `github` 就用它，没有就用 `origin`；也允许用 NUTRIFLOW_REMOTE 覆盖。
remote="${NUTRIFLOW_REMOTE:-}"
if [ -z "${remote}" ]; then
  if git remote get-url github >/dev/null 2>&1; then remote="github"; else remote="origin"; fi
fi
echo "发布到 remote：${remote}"

# gh 只用来催一次 Pages 重建（不催也会自己build，只是慢一点）。
# 沙箱/CI 里常常没装，别为这个把整条发布流程断掉。
rebuild_pages(){
  if command -v gh >/dev/null 2>&1; then
    gh api --method POST repos/wang-piaoliang/nutriflow/pages/builds --silent || true
  else
    echo "没装 gh，跳过催 Pages 重建——GitHub 自己会构建，等一两分钟。"
  fi
}

git diff --check
npm test
# 推 HEAD 而不是本地的 `main`：这个仓库平时在 claude/... 分支上开发，本地 main
# 早就落后了，写死 `main` 会被 non-fast-forward 顶回来。HEAD 不是 main 的祖先时
# git 自己会拒绝，这道保险还在。
git push "${remote}" HEAD:main

# Publish public/ to gh-pages as a single commit stacked on the current remote
# tip. This replaced `git subtree split --prefix=public`, whose synthetic
# history diverges from whatever gh-pages already points at, so every publish
# after the first divergence failed with non-fast-forward and needed manual
# recovery. Stacking always fast-forwards and keeps the remote history intact.
source_commit="$(git rev-parse --short HEAD)"
pages_tree="$(git rev-parse "HEAD:public")"

if git fetch "${remote}" gh-pages 2>/dev/null; then
  pages_parent="$(git rev-parse FETCH_HEAD)"

  if [ "$(git rev-parse "${pages_parent}^{tree}")" = "${pages_tree}" ]; then
    echo "gh-pages already serves this public/ tree; skipping the deploy commit."
    rebuild_pages
    exit 0
  fi

  pages_commit="$(git commit-tree "${pages_tree}" -p "${pages_parent}" -m "Publish NutriFlow public/ from ${source_commit}")"
else
  # First publish: gh-pages does not exist on the remote yet.
  pages_commit="$(git commit-tree "${pages_tree}" -m "Publish NutriFlow public/ from ${source_commit}")"
fi

git push "${remote}" "${pages_commit}:refs/heads/gh-pages"
rebuild_pages
