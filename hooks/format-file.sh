#!/usr/bin/env bash
# PostToolUse (Write|Edit) hook: düzenlenen dosyayı, projenin KENDİ yapılandırdığı
# formatter ile biçimlendirir. Projede formatter yapılandırılmamışsa hiçbir şey yapmaz,
# böylece formatter kullanmayan projelerde ilgisiz diff oluşmaz.
# Hata durumunda düzenlemeyi asla engellemez (her zaman exit 0).

file=$(jq -r '.tool_response.filePath // .tool_input.file_path // empty')
[ -n "$file" ] && [ -f "$file" ] || exit 0

# Dosyanın bulunduğu dizinden yukarı doğru, verilen işaret dosyalarından birini içeren
# ilk dizini döndürür.
find_up() {
  local dir
  dir=$(dirname "$file")
  while [ "$dir" != "/" ]; do
    for marker in "$@"; do
      [ -e "$dir/$marker" ] && { echo "$dir"; return 0; }
    done
    dir=$(dirname "$dir")
  done
  return 1
}

case "$file" in
  */node_modules/*|*/.git/*|*/build/*|*/dist/*|*.min.js|*.lock|*-lock.json) exit 0 ;;
esac

case "$file" in
  *.js|*.jsx|*.ts|*.tsx|*.mjs|*.cjs|*.json|*.css|*.scss|*.html|*.vue|*.md|*.yml|*.yaml)
    if root=$(find_up biome.json biome.jsonc) && [ -x "$root/node_modules/.bin/biome" ]; then
      (cd "$root" && node_modules/.bin/biome format --write "$file")
    elif root=$(find_up .prettierrc .prettierrc.json .prettierrc.js .prettierrc.cjs .prettierrc.mjs \
                         .prettierrc.yaml .prettierrc.yml prettier.config.js prettier.config.cjs prettier.config.mjs) \
         && [ -x "$root/node_modules/.bin/prettier" ]; then
      (cd "$root" && node_modules/.bin/prettier --write --ignore-unknown "$file")
    fi
    ;;
  *.py)
    if root=$(find_up pyproject.toml ruff.toml .ruff.toml); then
      if { [ -f "$root/ruff.toml" ] || [ -f "$root/.ruff.toml" ] || grep -q '^\[tool\.ruff' "$root/pyproject.toml" 2>/dev/null; } \
         && command -v ruff >/dev/null; then
        (cd "$root" && ruff format "$file")
      elif grep -q '^\[tool\.black' "$root/pyproject.toml" 2>/dev/null && command -v black >/dev/null; then
        (cd "$root" && black -q "$file")
      fi
    fi
    ;;
  *.dart)
    find_up pubspec.yaml >/dev/null && command -v dart >/dev/null && dart format "$file"
    ;;
  *.go)
    command -v gofmt >/dev/null && gofmt -w "$file"
    ;;
  *.rs)
    find_up Cargo.toml >/dev/null && command -v rustfmt >/dev/null && rustfmt --edition 2021 "$file"
    ;;
esac >/dev/null 2>&1

exit 0
