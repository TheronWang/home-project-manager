#!/usr/bin/env bash
# Append an update note for a project (format: see README.md, "Update notes").
# Usage: log-update.sh "<Project>" <kind> <author> "<message>"   (message may also come from stdin)
#        log-update.sh --list                                     (list project and program names)
#
# The vault is $VAULT, or the nearest folder above the current directory that contains .obsidian/.
# The updates subfolder is read from the plugin's settings (default "Updates").
set -euo pipefail

find_vault() {
  local d="$PWD"
  while [[ "$d" != "/" ]]; do
    [[ -d "$d/.obsidian" ]] && { printf '%s' "$d"; return 0; }
    d="$(dirname "$d")"
  done
  return 1
}
VAULT="${VAULT:-$(find_vault || true)}"
[[ -n "$VAULT" && -d "$VAULT/.obsidian" ]] || { echo "error: set VAULT to your vault folder (no .obsidian/ found above $PWD)" >&2; exit 2; }

setting() { # setting <key> <default>: read a string value from the plugin's data.json
  local f="$VAULT/.obsidian/plugins/home-project-manager/data.json" v=""
  [[ -f "$f" ]] && v="$(sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$f" | head -1)"
  printf '%s' "${v:-$2}"
}
UPDATES="$(setting updatesFolder Updates)"
ARCHIVE="$(setting archiveRoot Archive/Projects)"

# Frontmatter "type:" of a note, or nothing.
note_type() { awk 'NR==1 && !/^---/ { exit } NR>1 && /^---/ { exit } /^type:/ { print $2; exit }' "$1"; }

hubs() { # all markdown files outside .obsidian, updates folders and the archive
  find "$VAULT" -type f -name "${1:-*}.md" -not -path "*/.obsidian/*" -not -path "*/$UPDATES/*" \
    -not -path "$VAULT/$ARCHIVE/*" -print0
}

if [[ "${1:-}" == "--list" ]]; then
  hubs | while IFS= read -r -d '' f; do
    t="$(note_type "$f")"
    [[ "$t" == project || "$t" == program ]] && printf '%-28s %s\n' "$(basename "$f" .md)" "$t"
  done | sort
  exit 0
fi

project="${1:?project name required}"
kind="${2:?kind required: progress|milestone|blocker|decision|note}"
author="${3:?author required: me|claude|codex|...}"
message="${4:-$(cat)}"

case "$kind" in progress|milestone|blocker|decision|note) ;; *)
  echo "error: kind must be progress|milestone|blocker|decision|note" >&2; exit 2;;
esac
author="$(printf '%s' "$author" | tr '[:upper:]' '[:lower:]')"
[[ -n "${message// /}" ]] || { echo "error: empty message" >&2; exit 2; }

hub=""
while IFS= read -r -d '' f; do
  if [[ "$(note_type "$f")" == project ]]; then
    [[ -n "$hub" ]] && { echo "error: more than one project named '$project'" >&2; exit 3; }
    hub="$f"
  fi
done < <(hubs "$project")
[[ -n "$hub" ]] || { echo "error: no note named '$project' with type: project" >&2; exit 3; }

dir="$(dirname "$hub")/$UPDATES"
mkdir -p "$dir"
stamp_file="$(date '+%Y-%m-%d %H%M')"
stamp_iso="$(date '+%Y-%m-%dT%H:%M')"
path="$dir/$stamp_file - $author.md"
n=2
while [[ -e "$path" ]]; do path="$dir/$stamp_file - $author $n.md"; n=$((n+1)); done

{
  printf -- '---\ntype: update\nproject: "[[%s]]"\ndate: %s\nauthor: %s\nkind: %s\n---\n' "$project" "$stamp_iso" "$author" "$kind"
  printf '%s\n' "$message"
} > "$path"
echo "${path#"$VAULT"/}"
