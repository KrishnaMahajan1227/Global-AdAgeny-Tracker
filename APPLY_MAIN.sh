#!/usr/bin/env bash
set -euo pipefail
PROJECT="${1:-/d/DarshanAdField}"
PATCH="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT"
test -f package.json || { echo 'Open existing AdRoute project root' >&2; exit 1; }
[ "$(git branch --show-current)" = main ] || { echo 'Use existing main branch' >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo 'Working tree must be clean before applying' >&2; exit 1; }
files=(src/App.tsx src/components/AdminLayout.tsx src/pages/PurchaseOrdersPage.tsx src/pages/SupplyOrdersPage.tsx)
allow=(
  '994435cfad2b67b4e69691485195d40b87b0cd28 dae666206aeb8c9dce0497a3076e5dda6d158911'
  'e52a7722978ca6186953d842611e3f49cc3fe672 8ef5ba124d9be1a1cbebdf28bbe93b613b352894'
  '3431406ddd701959028c8ea5be8f24031dbf7c67 7c27e031f7cc0a023e7fd8568a48d0378cc25b81'
  '0a37687759c9d64460877425cabff1466bdccc15 9073ea2b0aed8fc1b04688a0dc034642273f690c'
)
for i in "${!files[@]}"; do
 f="${files[$i]}"
 test -f "$PATCH/$f" && test -f "$f" || { echo "Missing: $f" >&2; exit 1; }
 sha="$(git rev-parse "HEAD:$f")"
 [[ " ${allow[$i]} " == *" $sha "* ]] || { echo "Version mismatch: $f [$sha] — no files changed" >&2; exit 1; }
done
backup="$(git rev-parse --git-dir)/adroute-workorders-backup-$(date +%Y%m%d-%H%M%S)"
for f in "${files[@]}"; do mkdir -p "$backup/$(dirname "$f")"; cp "$f" "$backup/$f"; done
for f in "${files[@]}"; do cp "$PATCH/$f" "$f"; done
git diff --check
echo "Updated 4 files; backups at $backup"
git diff --stat
