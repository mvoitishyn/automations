#!/usr/bin/env bash
# Fail if the repo would publish something private.
#   scripts/check-private.sh            scan every tracked file, plus commit author emails
#   scripts/check-private.sh --staged   scan only what is staged (used by the pre-commit hook)
# Generic checks: private IP addresses, home-directory paths, personal email addresses, key-shaped strings.
# Personal checks: one word or regex per line in ~/.config/automations/private-words (never committed),
# e.g. client names, colleagues, internal hostnames.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
WORDS="${XDG_CONFIG_HOME:-$HOME/.config}/automations/private-words"

if [ "${1:-}" = "--staged" ]; then
  mapfile -t files < <(git diff --cached --name-only --diff-filter=ACMR)
else
  mapfile -t files < <(git ls-files)
fi
[ ${#files[@]} -eq 0 ] && exit 0
# the checker itself and the license (which names the author on purpose) are exempt
scan=()
for f in "${files[@]}"; do
  case "$f" in scripts/check-private.sh|LICENSE) ;; *) [ -f "$f" ] && scan+=("$f") ;; esac
done
[ ${#scan[@]} -eq 0 ] && exit 0

bad=0
check() { # <label> <extended regex>
  local hits
  hits=$(grep -nIEo "$2" -- "${scan[@]}" 2>/dev/null || true)
  if [ -n "$hits" ]; then echo "✗ $1:"; echo "$hits" | sed 's/^/    /'; bad=1; fi
}
check "private IP address" '\b(10\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])|192\.168)\.[0-9]{1,3}\.[0-9]{1,3}\b'
check "home directory path" '/(home|Users)/[a-z][a-z0-9_-]+'
emails=$(grep -nIEo '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}' -- "${scan[@]}" 2>/dev/null | grep -vE '@(example\.(com|org)|users\.noreply\.github\.com)' || true)
[ -n "$emails" ] && { echo "✗ email address:"; echo "$emails" | sed 's/^/    /'; bad=1; }
check "API key or token" '(sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)'
if [ -f "$WORDS" ]; then
  pattern=$(grep -vE '^\s*(#|$)' "$WORDS" | paste -sd'|' -)
  [ -n "$pattern" ] && {
    hits=$(grep -nIiEo "$pattern" -- "${scan[@]}" 2>/dev/null || true)
    if [ -n "$hits" ]; then echo "✗ private word (from $WORDS):"; echo "$hits" | sed 's/^/    /'; bad=1; fi
  }
fi
if [ "${1:-}" != "--staged" ]; then
  emails=$(git log --format='%ae%n%ce' | sort -u | grep -vE '@users\.noreply\.github\.com$|^noreply@github\.com$' || true)
  if [ -n "$emails" ]; then echo "✗ commits with a personal email (use your GitHub noreply address):"; echo "$emails" | sed 's/^/    /'; bad=1; fi
  trailers=$(git log --format=%B | grep -iE '^co-authored-by:.*(claude|anthropic)' | sort -u || true)
  if [ -n "$trailers" ]; then echo "✗ AI co-author trailers in commit messages:"; echo "$trailers" | sed 's/^/    /'; bad=1; fi
fi
[ $bad -eq 0 ] && echo "✓ no private data found in ${#scan[@]} files"
exit $bad
