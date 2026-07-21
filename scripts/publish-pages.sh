#!/usr/bin/env bash
set -euo pipefail

git diff --check
npm test
git push github main

# Publish public/ to gh-pages as a single commit stacked on the current remote
# tip. This replaced `git subtree split --prefix=public`, whose synthetic
# history diverges from whatever gh-pages already points at, so every publish
# after the first divergence failed with non-fast-forward and needed manual
# recovery. Stacking always fast-forwards and keeps the remote history intact.
source_commit="$(git rev-parse --short HEAD)"
pages_tree="$(git rev-parse "HEAD:public")"

if git fetch github gh-pages 2>/dev/null; then
  pages_parent="$(git rev-parse FETCH_HEAD)"

  if [ "$(git rev-parse "${pages_parent}^{tree}")" = "${pages_tree}" ]; then
    echo "gh-pages already serves this public/ tree; skipping the deploy commit."
    gh api --method POST repos/wang-piaoliang/nutriflow/pages/builds --silent
    exit 0
  fi

  pages_commit="$(git commit-tree "${pages_tree}" -p "${pages_parent}" -m "Publish NutriFlow public/ from ${source_commit}")"
else
  # First publish: gh-pages does not exist on the remote yet.
  pages_commit="$(git commit-tree "${pages_tree}" -m "Publish NutriFlow public/ from ${source_commit}")"
fi

git push github "${pages_commit}:refs/heads/gh-pages"
gh api --method POST repos/wang-piaoliang/nutriflow/pages/builds --silent
