#!/usr/bin/env bash
set -euo pipefail

git diff --check
npm test
git push github main

pages_commit="$(git subtree split --prefix=public HEAD)"
git push github "${pages_commit}:refs/heads/gh-pages"
gh api --method POST repos/wang-piaoliang/nutriflow/pages/builds --silent
