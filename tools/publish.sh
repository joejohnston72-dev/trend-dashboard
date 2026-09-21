#!/usr/bin/env bash
# Publish data/*.json to main safely when several book runs finish at once.
#
# Fixes: "cannot lock ref 'refs/heads/main': is at <sha> but expected <sha>"
# caused by two runs pushing within the same second.
#
# Usage: tools/publish.sh [commit message]
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${PUBLISH_BRANCH:-main}"
MSG="${1:-data: update snapshot (combined.json, crypto.json, markets.json)}"
LOCK_DIR="${TMPDIR:-/tmp}/trend-dashboard-publish.lock"
LOCK_TIMEOUT=300   # give up waiting for a peer run after 5 min
STALE_AFTER=600    # reap a lock older than 10 min (crashed run)
MAX_ATTEMPTS=5

cd "$REPO_DIR" || exit 1

log() { printf '[publish] %s\n' "$*" >&2; }

# Mtime of the lock, in seconds. GNU stat wants -c %Y, BSD/macOS wants -f %m,
# and each prints junk to stdout when handed the other's flag -- so validate
# that what came back is digits before it reaches any arithmetic.
lock_age() {
  local t
  t=$(stat -c %Y "$LOCK_DIR" 2>/dev/null) || t=""
  case "$t" in ""|*[!0-9]*) t=$(stat -f %m "$LOCK_DIR" 2>/dev/null) || t="" ;; esac
  case "$t" in ""|*[!0-9]*) return 1 ;; esac
  echo $(( $(date +%s) - t ))
}

acquire_lock() {
  local waited=0 age
  until mkdir "$LOCK_DIR" 2>/dev/null; do
    age=$(lock_age) || age=0
    if [ "$age" -gt "$STALE_AFTER" ]; then
      log "reaping stale lock (${age}s old)"
      rmdir "$LOCK_DIR" 2>/dev/null
      continue
    fi
    if [ "$waited" -ge "$LOCK_TIMEOUT" ]; then
      log "timed out waiting ${LOCK_TIMEOUT}s for peer run"
      return 1
    fi
    sleep 2
    waited=$(( waited + 2 ))
  done
  trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT INT TERM
  [ "$waited" -gt 0 ] && log "waited ${waited}s for peer run"
  return 0
}

acquire_lock || exit 1

git checkout -q "$BRANCH" 2>/dev/null || { log "cannot check out $BRANCH"; exit 1; }
git add -A data
if git diff --cached --quiet; then
  log "no data changes to publish"
  exit 0
fi
git commit -q -m "$MSG" || { log "commit failed"; exit 1; }

# Re-fetch and replay on every attempt: a peer run may land between tries.
delay=2
for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  git fetch -q origin "$BRANCH" || log "fetch failed (attempt $attempt)"

  if [ -n "$(git rev-list --count "HEAD..origin/$BRANCH" 2>/dev/null)" ] \
     && [ "$(git rev-list --count "HEAD..origin/$BRANCH")" != "0" ]; then
    # Peer run already published. Replay our snapshot on top of theirs.
    # During a rebase our commits are the ones being applied, so "theirs" is
    # us -- that keeps this run's (newer) data/*.json on a conflict.
    if ! git rebase -q -X theirs "origin/$BRANCH"; then
      log "rebase failed, aborting rebase"
      git rebase --abort 2>/dev/null
      exit 1
    fi
  fi

  if push_err=$(git push -u origin "$BRANCH" 2>&1); then
    log "published $(git rev-parse --short HEAD) to $BRANCH"
    exit 0
  fi

  log "attempt $attempt/$MAX_ATTEMPTS rejected: $(printf '%s' "$push_err" | tr '\n' ' ' | cut -c1-160)"
  log "retrying in ${delay}s"
  sleep "$delay"
  delay=$(( delay * 2 ))
done

log "FAILED to publish after $MAX_ATTEMPTS attempts"
exit 1
