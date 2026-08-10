#!/usr/bin/env bash
#
# Cut a release: bump every manifest, commit, tag, push, and open the GitHub
# release. The tag is what triggers CI to build the image and publish the CLI.
#
#   bun run release patch      0.0.6 -> 0.0.7
#   bun run release minor      0.0.6 -> 0.1.0
#   bun run release major      0.0.6 -> 1.0.0
#   bun run release 0.2.0      explicitly
#
#   --dry-run   print every step, change nothing
#   --no-verify skip the local gate (see below)
#
# WHY THE CHECKS RUN LOCALLY FIRST, even though CI runs them again: this pushes
# a tag, and the tag publishes to npm. An npm version is permanent — unpublish
# only works for 72 hours, and not at all once something depends on it. Four
# minutes of tests is cheap next to a broken version that can never be reused.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DRY_RUN=0
VERIFY=1
BUMP=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-verify) VERIFY=0 ;;
    -*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *) BUMP="$arg" ;;
  esac
done

die() { echo "✗ $*" >&2; exit 1; }
step() { echo; echo "── $*"; }
run() { if [ "$DRY_RUN" = "1" ]; then echo "   would run: $*"; else "$@"; fi; }

[ -n "$BUMP" ] || die "usage: bun run release <patch|minor|major|x.y.z> [--dry-run] [--no-verify]"

# ── the release must be reproducible from one commit ────────────────────────
step "Checking the working tree"
[ -z "$(git status --porcelain)" ] || die "working tree is dirty — commit or stash first."

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || die "on branch '$BRANCH' — releases are cut from main."

# Fetch, then refuse to release something the remote does not have or has moved
# past. Tagging a commit that is not on origin/main produces a release nobody
# can reproduce from a clone.
git fetch --quiet origin main --tags
LOCAL="$(git rev-parse @)"
REMOTE="$(git rev-parse origin/main)"
BASE="$(git merge-base @ origin/main)"
if [ "$LOCAL" != "$REMOTE" ]; then
  [ "$LOCAL" = "$BASE" ] && die "main is behind origin — pull first."
  [ "$REMOTE" = "$BASE" ] || die "main has diverged from origin — reconcile first."
  echo "   local is ahead of origin by $(git rev-list --count origin/main..@) commit(s); they will be pushed."
fi
echo "   clean, on main, in step with origin"

# ── work out the next version from the CURRENT one ──────────────────────────
step "Working out the version"
CURRENT="$(node -p "require('$ROOT/package.json').version")"
case "$BUMP" in
  patch|minor|major)
    IFS=. read -r MA MI PA <<<"${CURRENT%%-*}"
    case "$BUMP" in
      patch) PA=$((PA + 1)) ;;
      minor) MI=$((MI + 1)); PA=0 ;;
      major) MA=$((MA + 1)); MI=0; PA=0 ;;
    esac
    VERSION="$MA.$MI.$PA"
    ;;
  *) VERSION="$BUMP" ;;
esac
TAG="v$VERSION"
echo "   $CURRENT -> $VERSION"

# A tag that already exists means this version was already cut. Re-cutting it
# would move a tag people may have pulled, and npm would refuse the publish
# anyway — but only after the tag had been pushed.
git rev-parse "$TAG" >/dev/null 2>&1 && die "tag $TAG already exists."
git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1 &&
  die "tag $TAG already exists on origin."

# ── the gate ────────────────────────────────────────────────────────────────
if [ "$VERIFY" = "1" ]; then
  step "Running the checks (--no-verify to skip)"
  run bun install --frozen-lockfile
  run bun run typecheck
  run bun run check
  run bun run test
  run bun run cli:build
  # The artifact people install has to run under plain Node, not just Bun.
  [ "$DRY_RUN" = "1" ] || node packages/cli/dist/index.js help >/dev/null ||
    die "the built CLI does not run under node."
  echo "   green"
else
  echo
  echo "⚠ skipping checks — CI will still run them, but the tag publishes to npm first."
fi

# ── do it ───────────────────────────────────────────────────────────────────
step "Releasing $TAG"
run bun scripts/version.ts "$VERSION"
run bun run version:check
run git commit -am "release $VERSION"
run git tag -a "$TAG" -m "$VERSION"
run git push --follow-tags origin main

if command -v gh >/dev/null 2>&1; then
  # --generate-notes writes the changelog from the commits since the last tag,
  # which is why the commit messages in this repo are worth the trouble.
  run gh release create "$TAG" --generate-notes --title "$VERSION"
else
  echo "   gh not installed — create the GitHub release by hand if you want one."
fi

echo
if [ "$DRY_RUN" = "1" ]; then
  echo "Dry run — nothing changed."
else
  echo "Released $TAG. CI is building the image and publishing @alltinghq/cli."
  echo "  gh run watch"
fi
