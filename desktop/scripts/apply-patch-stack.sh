#!/usr/bin/env bash
: "${DSH_ROOT:?set DSH_ROOT to your working checkout (see desktop/BUILD.md)}"; export DSH_ROOT
# Bring the pinned vendor tree to exactly HEAD + patches/*.patch (in order).
#  - files untouched by the stack's patches are pristine → apply the whole stack;
#  - files already equal to the fully patched result      → nothing to do;
#  - anything else                                         → refuse (regenerate patches or reset first).
set -euo pipefail
SRC=${DSH_ROOT}/vendor/deepseek-harness-desktop-src
PATCHES=(${DSH_ROOT}/desktop-local-build/patches/*.patch)
cd "$SRC"
FILES=()   # bash 3.2 on macOS: no mapfile
while IFS= read -r line; do FILES+=("$line"); done < <(for p in "${PATCHES[@]}"; do git apply --numstat "$p" | cut -f3; done | sort -u)
WORK="$(mktemp -d "${TMPDIR:-/tmp}/dsh-patch-stack.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
(cd "$WORK" && git init -q .)
for f in "${FILES[@]}"; do
  if git cat-file -e "HEAD:$f" 2>/dev/null; then mkdir -p "$WORK/$(dirname "$f")"; git show "HEAD:$f" > "$WORK/$f"; fi
done
(cd "$WORK" && git apply "${PATCHES[@]}")
pristine=true; patched=true
for f in "${FILES[@]}"; do
  if git cat-file -e "HEAD:$f" 2>/dev/null; then
    git diff --quiet HEAD -- "$f" || pristine=false
  elif [ -e "$f" ]; then
    pristine=false
  fi
  if [ -e "$WORK/$f" ]; then cmp -s "$WORK/$f" "$f" || patched=false; else [ ! -e "$f" ] || patched=false; fi
done
if $patched; then echo "patch stack already applied (${#PATCHES[@]} patches, ${#FILES[@]} files)"; exit 0; fi
if $pristine; then git apply "${PATCHES[@]}"; echo "applied patch stack (${#PATCHES[@]} patches, ${#FILES[@]} files)"; exit 0; fi
echo "vendor tree differs from HEAD + patch stack; regenerate patches or reset these files:" >&2
for f in "${FILES[@]}"; do [ -e "$WORK/$f" ] && ! cmp -s "$WORK/$f" "$f" && echo "  $f" >&2; done
exit 5
