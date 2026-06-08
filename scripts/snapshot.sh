#!/usr/bin/env bash
#
# Dev database snapshot tool (pg_dump-based).
#
# Each snapshot is a folder under snapshots/<name>/ containing:
#   data.sql.gz  - gzipped whole-database pg_dump (--clean --if-exists)
#   blobs/       - copy of the .blobstore files (uploaded attachments)
#   meta.json    - name, description, createdAt, git ref, counts
#
# Usage (from anywhere; paths resolve to repo root):
#   scripts/snapshot.sh export <name> [description]
#   scripts/snapshot.sh import <name>     # REPLACES dev DB + blobstore
#   scripts/snapshot.sh list
#
# Reads DATABASE_URL and BLOB_LOCAL_DIR from the root .env.
# Note: client pg tools are 18.x, server is 16.x -> we use plain SQL + psql
# (the dump comes from the 16 server, so it stays 16-compatible on restore).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SNAP_DIR="$ROOT/snapshots"

# --- load env -------------------------------------------------------------
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi
: "${DATABASE_URL:?DATABASE_URL not set (check root .env)}"

BLOB_DIR="${BLOB_LOCAL_DIR:-./.blobstore}"
case "$BLOB_DIR" in
  /*) ;;                                  # already absolute
  *) BLOB_DIR="$ROOT/${BLOB_DIR#./}" ;;   # resolve relative to repo root
esac

utc_now() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
die() { echo "✗ $*" >&2; exit 1; }

# --- commands -------------------------------------------------------------
cmd="${1:-}"; shift || true

case "$cmd" in
  export)
    name="${1:-}"; [[ -n "$name" ]] || die "usage: snapshot.sh export <name> [description]"
    shift || true
    desc="${*:-}"
    dest="$SNAP_DIR/$name"
    mkdir -p "$dest"

    echo "→ dumping database → $dest/data.sql.gz"
    pg_dump --format=plain --clean --if-exists --no-owner --no-privileges "$DATABASE_URL" \
      | gzip > "$dest/data.sql.gz"

    echo "→ copying blobs from $BLOB_DIR"
    rm -rf "$dest/blobs"; mkdir -p "$dest/blobs"
    [[ -d "$BLOB_DIR" ]] && cp -R "$BLOB_DIR/." "$dest/blobs/" 2>/dev/null || true

    blob_files=$(find "$dest/blobs" -type f | wc -l | tr -d ' ')
    data_size=$(du -h "$dest/data.sql.gz" | cut -f1 | tr -d ' ')
    pg_server=$(psql "$DATABASE_URL" -tAc 'show server_version' 2>/dev/null | tr -d ' ')
    git_branch=$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
    git_commit=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo "")

    cat > "$dest/meta.json" <<JSON
{
  "name": "$name",
  "description": "$desc",
  "createdAt": "$(utc_now)",
  "database": "${DATABASE_URL##*/}",
  "pgServer": "$pg_server",
  "gitBranch": "$git_branch",
  "gitCommit": "$git_commit",
  "blobFiles": $blob_files,
  "dataSize": "$data_size"
}
JSON
    echo "✓ snapshot '$name' created — $blob_files blob file(s), $data_size data"
    ;;

  import)
    name="${1:-}"; [[ -n "$name" ]] || die "usage: snapshot.sh import <name>"
    src="$SNAP_DIR/$name"
    [[ -d "$src" ]] || die "no snapshot '$name' at $src"
    [[ -f "$src/data.sql.gz" ]] || die "missing $src/data.sql.gz"

    echo "⚠ REPLACING current dev database AND $BLOB_DIR with snapshot '$name'"
    echo "→ restoring database"
    gunzip -c "$src/data.sql.gz" \
      | psql --set ON_ERROR_STOP=1 --single-transaction "$DATABASE_URL" >/dev/null

    echo "→ restoring blobs → $BLOB_DIR"
    rm -rf "$BLOB_DIR"; mkdir -p "$BLOB_DIR"
    [[ -d "$src/blobs" ]] && cp -R "$src/blobs/." "$BLOB_DIR/" 2>/dev/null || true

    echo "✓ snapshot '$name' loaded"
    ;;

  list)
    [[ -d "$SNAP_DIR" ]] || { echo "(no snapshots yet)"; exit 0; }
    found=0
    for d in "$SNAP_DIR"/*/; do
      [[ -d "$d" ]] || continue
      found=1
      n=$(basename "$d")
      if [[ -f "$d/meta.json" ]]; then
        created=$(grep '"createdAt"' "$d/meta.json" | sed 's/.*: *"//;s/".*//')
        desc=$(grep '"description"' "$d/meta.json" | sed 's/.*: *"//;s/".*//')
        printf "  %-26s %s  %s\n" "$n" "$created" "$desc"
      else
        printf "  %s\n" "$n"
      fi
    done
    [[ "$found" == 1 ]] || echo "(no snapshots yet)"
    ;;

  *)
    echo "usage: snapshot.sh {export <name> [description] | import <name> | list}" >&2
    exit 1
    ;;
esac
