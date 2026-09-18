if [ -n "${OPENCLAW_PR_GITHUB_SNAPSHOT_ROOT:-}" ]; then
  pr_gh_snapshot_root=$(cd "$OPENCLAW_PR_GITHUB_SNAPSHOT_ROOT" && pwd -P) || return 1
  pr_gh_source_scripts=$(cd "${BASH_SOURCE[0]%/*}/.." && pwd -P) || return 1
  if [ "$pr_gh_source_scripts" != "$pr_gh_snapshot_root/scripts" ]; then
    # The locator supplies addressing only. Verify the entire executable closure
    # before handoff, including real directories so Node cannot follow a new import root.
    for pr_gh_snapshot_path in scripts scripts/pr-lib scripts/lib; do
      if [ ! -d "$pr_gh_snapshot_root/$pr_gh_snapshot_path" ] ||
        [ -L "$pr_gh_snapshot_root/$pr_gh_snapshot_path" ]; then
        echo "Refusing unverified scripts/pr GitHub helper snapshot." >&2
        return 1
      fi
    done
    for pr_gh_snapshot_path in pr-lib/github.sh pr-lib/github.mjs lib/plain-gh.mjs lib/direct-run.mjs; do
      if [ ! -f "$pr_gh_snapshot_root/scripts/$pr_gh_snapshot_path" ] ||
        [ -L "$pr_gh_snapshot_root/scripts/$pr_gh_snapshot_path" ] ||
        ! cmp -s "$pr_gh_source_scripts/$pr_gh_snapshot_path" "$pr_gh_snapshot_root/scripts/$pr_gh_snapshot_path"; then
        echo "Refusing unverified scripts/pr GitHub helper snapshot." >&2
        return 1
      fi
    done
    source "$pr_gh_snapshot_root/scripts/pr-lib/github.sh"
    return $?
  fi
fi
unset pr_gh_snapshot_root pr_gh_source_scripts pr_gh_snapshot_path

pr_gh() {
  node "${BASH_SOURCE[0]%/*}/github.mjs" read "$@"
}

pr_gh_plain() {
  node "${BASH_SOURCE[0]%/*}/github.mjs" plain "$@"
}
