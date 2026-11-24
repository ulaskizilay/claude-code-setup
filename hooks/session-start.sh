#!/usr/bin/env bash
# SessionStart hook.
#   Bir git deposunun içinde açılırsa: o deponun özeti.
#   Birden fazla depoyu içeren bir klasörde açılırsa (ör. ~/dev/workspace):
#     3 seviyeye kadar alt dizinlerdeki her deponun/projenin özeti.
#   Proje içermeyen bir dizinde (ör. ev dizini): son çalışılan projelerin listesi.
# Kullanıcıya systemMessage, modele additionalContext döner. Oturumu asla engellemez.

input=$(cat)
cwd=$(jq -r '.cwd // empty' <<<"$input")
source_type=$(jq -r '.source // "startup"' <<<"$input")
[ -n "$cwd" ] && [ -d "$cwd" ] || cwd=$PWD
cd "$cwd" 2>/dev/null || exit 0

MARKERS=(package.json pubspec.yaml pyproject.toml manage.py requirements.txt go.mod Cargo.toml composer.json Makefile)
SKIP_DIRS='^(node_modules|build|dist|vendor|venv|\..*)$'
SCAN_DEPTH=3

user_lines=()
model_lines=()

# ---------- Yardımcılar ----------

has_marker() {
  local m
  for m in "${MARKERS[@]}"; do [ -e "$1/$m" ] && return 0; done
  return 1
}

is_git_root() { [ -e "$1/.git" ]; }

short_path() { echo "${1/#$HOME/\~}"; }

subdirs() {
  local d
  for d in "$1"/*/; do
    d=${d%/}
    [ -d "$d" ] || continue
    basename "$d" | grep -qE "$SKIP_DIRS" && continue
    echo "$d"
  done
}

# Bir dizinin altındaki depo/projeleri bulur; bulduğu dizinin içine inmez.
find_repos() {
  local dir=$1 depth=$2 d
  while IFS= read -r d; do
    if is_git_root "$d" || has_marker "$d"; then
      echo "$d"
    elif [ "$depth" -lt "$SCAN_DEPTH" ]; then
      find_repos "$d" $((depth + 1))
    fi
  done < <(subdirs "$dir")
}

# Bir deponun komut çalıştırılabilir bileşenleri: kökte proje dosyası varsa kök,
# yoksa proje dosyası olan ilk seviye alt dizinler.
components_of() {
  local repo=$1 d
  if has_marker "$repo"; then echo "$repo"; return; fi
  while IFS= read -r d; do has_marker "$d" && echo "$d"; done < <(subdirs "$repo")
}

pkg_runner() {
  if   [ -f "$1/pnpm-lock.yaml" ]; then echo "pnpm"
  elif [ -f "$1/yarn.lock" ]; then echo "yarn"
  elif [ -f "$1/bun.lockb" ] || [ -f "$1/bun.lock" ]; then echo "bun"
  else echo "npm run"; fi
}

has_js_dep() {
  jq -e --arg p "$2" '(.dependencies // {}) + (.devDependencies // {}) | has($p)' "$1/package.json" >/dev/null 2>&1
}

detect_commands() {
  local d=$1 out=() runner s single=""
  if [ -f "$d/package.json" ]; then
    runner=$(pkg_runner "$d")
    for s in test lint format typecheck type-check check build; do
      jq -e --arg s "$s" '.scripts[$s]' "$d/package.json" >/dev/null 2>&1 && out+=("$s: $runner $s")
    done
    if has_js_dep "$d" vitest; then single="npx vitest run <dosya>"
    elif has_js_dep "$d" jest; then single="npx jest <dosya> (isimle: npx jest -t \"<test adı>\")"
    fi
  fi
  if [ -f "$d/pubspec.yaml" ]; then
    if grep -q 'sdk: flutter' "$d/pubspec.yaml"; then
      out+=("test: flutter test" "analyze: flutter analyze"); single="flutter test <dosya>"
    else
      out+=("test: dart test" "analyze: dart analyze"); single="dart test <dosya>"
    fi
  fi
  if [ -f "$d/manage.py" ]; then
    out+=("test: python manage.py test"); single="python manage.py test <app.tests.modül>"
  fi
  if [ -f "$d/pyproject.toml" ] || [ -f "$d/requirements.txt" ]; then
    if grep -qiE '^\s*"?pytest|\[tool\.pytest' "$d/pyproject.toml" "$d/requirements.txt" "$d/requirements-dev.txt" 2>/dev/null; then
      out+=("test: pytest"); single="pytest <dosya>::<test>"
    fi
    { [ -f "$d/ruff.toml" ] || grep -q '^\[tool\.ruff' "$d/pyproject.toml" 2>/dev/null; } && out+=("lint: ruff check .")
  fi
  if [ -f "$d/go.mod" ]; then
    out+=("test: go test ./..." "lint: go vet ./..."); single="go test ./<paket>/... -run <TestAdı>"
  fi
  if [ -f "$d/Cargo.toml" ]; then
    out+=("test: cargo test" "lint: cargo clippy"); single="cargo test <test_adı>"
  fi
  if [ -f "$d/Makefile" ]; then
    for s in test lint format check; do
      grep -qE "^$s:" "$d/Makefile" && out+=("$s: make $s")
    done
  fi
  [ -n "$single" ] && out+=("tek test: $single")
  [ ${#out[@]} -gt 0 ] && printf '%s\n' "${out[@]}"
}

detect_formatter() {
  local d=$1
  if [ -f "$d/biome.json" ] || [ -f "$d/biome.jsonc" ]; then
    [ -x "$d/node_modules/.bin/biome" ] && echo "biome" || echo "biome (kurulu değil, çalışmaz)"
  elif compgen -G "$d/.prettierrc*" >/dev/null || compgen -G "$d/prettier.config.*" >/dev/null; then
    [ -x "$d/node_modules/.bin/prettier" ] && echo "prettier" || echo "prettier (kurulu değil, çalışmaz)"
  elif [ -f "$d/pubspec.yaml" ]; then echo "dart format"
  elif [ -f "$d/ruff.toml" ] || grep -q '^\[tool\.ruff' "$d/pyproject.toml" 2>/dev/null; then echo "ruff"
  elif grep -q '^\[tool\.black' "$d/pyproject.toml" 2>/dev/null; then echo "black"
  elif [ -f "$d/go.mod" ]; then echo "gofmt"
  elif [ -f "$d/Cargo.toml" ]; then echo "rustfmt"
  else echo "yok"; fi
}

# Kullanıcı satırı için kısa komut özeti: test, tek test, lint/analyze.
command_summary() {
  grep -E '^(test|tek test|lint|analyze):' <<<"$1" | sed 's/ (isimle:.*//' | awk -F: '!seen[$1]++' | paste -sd'|' | sed 's/|/ | /g'
}

adr_dir_of() {
  local d
  for d in docs/adr doc/adr adr docs/decisions; do
    [ -d "$1/$d" ] && { echo "$1/$d"; return; }
  done
}

# Son N ADR'nin "başlık [durum]" listesi.
adr_titles() {
  local dir=$1 limit=$2 files f t st
  mapfile -t files < <(ls "$dir" 2>/dev/null | grep -E '^[0-9]{4}-.*\.md$' | sort | tail -n "$limit")
  for f in "${files[@]}"; do
    t=$(head -1 "$dir/$f" | sed 's/^# *//')
    st=$(grep -m1 -iE '^(- )?(\*\*)?(durum|status):' "$dir/$f" | sed -E 's/^(- )?(\*\*)?[A-Za-z]+:(\*\*)? *//')
    echo "  $t${st:+ [$st]}"
  done
}

adr_count() { ls "$1" 2>/dev/null | grep -cE '^[0-9]{4}-.*\.md$'; }

# ---------- Bir depoyu özetle ----------
# $1: depo yolu, $2: etiket, $3: single | multi
describe_repo() {
  local repo=$1 label=$2 mode=$3
  local branch changed header comp cname cmds fmt summary adr n last indent
  local commit_limit=5 adr_limit=30
  [ "$mode" = multi ] && { commit_limit=3; adr_limit=10; }

  if is_git_root "$repo"; then
    branch=$(git -C "$repo" branch --show-current 2>/dev/null)
    if [ -z "$branch" ]; then
      branch=$(git -C "$repo" rev-parse --short HEAD 2>/dev/null)
      branch=${branch:+(detached) $branch}
      branch=${branch:-(commit yok)}
    fi
    changed=$(git -C "$repo" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    header="$label | branch: $branch | değişmiş dosya: $changed"
  else
    header="$label (git deposu değil)"
    changed=0
  fi
  [ "$mode" = single ] && header="Proje: $header"
  user_lines+=("$header")
  model_lines+=("" "Depo: $(short_path "$repo") -- $header")

  if [ -n "$branch" ] && [ "$branch" != "(commit yok)" ]; then
    model_lines+=("Son commit'ler:" "$(git -C "$repo" log --oneline -"$commit_limit" 2>/dev/null | sed 's/^/  /')")
    if [ "$changed" -gt 0 ]; then
      model_lines+=("Commit edilmemiş değişiklikler:" "$(git -C "$repo" status --short 2>/dev/null | head -15 | sed 's/^/  /')")
    fi
  fi

  indent=""; [ "$mode" = multi ] && indent="  "
  while IFS= read -r comp; do
    cname=""; [ "$comp" != "$repo" ] && cname="$(basename "$comp"): "
    cmds=$(detect_commands "$comp")
    fmt=$(detect_formatter "$comp")
    summary=$(command_summary "$cmds")
    user_lines+=("$indent${cname}${summary:-komut bulunamadı} | formatter: $fmt")
    [ -n "$cmds" ] && model_lines+=("Komutlar (${cname%: }${cname:+, }$(short_path "$comp")):" "$(sed 's/^/  /' <<<"$cmds")")
    [ -f "$comp/package.json" ] && [ ! -d "$comp/node_modules" ] \
      && user_lines+=("${indent}Uyarı: ${cname}node_modules yok, testler ve formatter çalışmaz")
    [ -f "$comp/.env.example" ] && [ ! -f "$comp/.env" ] \
      && user_lines+=("${indent}Uyarı: ${cname}.env.example var ama .env yok")
  done < <(components_of "$repo")

  adr=$(adr_dir_of "$repo")
  if [ -n "$adr" ]; then
    n=$(adr_count "$adr")
    if [ "$n" -gt 0 ]; then
      last=$(ls "$adr" | grep -E '^[0-9]{4}-.*\.md$' | sort | tail -1)
      user_lines+=("${indent}ADR: $n kayıt (son: ${last%.md})")
      model_lines+=("ADR'ler ($(short_path "$adr"), toplam $n, son $adr_limit gösteriliyor). Yeni karar vermeden önce ilgili olanları oku:" "$(adr_titles "$adr" "$adr_limit")")
    fi
  fi
}

# ---------- Proje içermeyen dizin: son çalışılan projeler ----------
show_overview() {
  local lines=() f c line branch changed
  local -A seen=()
  while IFS= read -r f; do
    c=$(grep -m1 -o '"cwd":"[^"]*"' "$f" 2>/dev/null | cut -d'"' -f4)
    [ -n "$c" ] && [ -d "$c" ] && [ "$c" != "$HOME" ] && [ "$c" != "$cwd" ] || continue
    [ -n "${seen[$c]}" ] && continue
    seen[$c]=1
    line="$(date -r "$f" '+%d.%m %H:%M')  $(short_path "$c")"
    branch=$(git -C "$c" branch --show-current 2>/dev/null)
    if [ -n "$branch" ]; then
      changed=$(git -C "$c" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
      line+=" (branch: $branch, değişmiş dosya: $changed)"
    fi
    lines+=("$line")
    [ ${#lines[@]} -ge 6 ] && break
  done < <(ls -t "$HOME"/.claude/projects/*/*.jsonl 2>/dev/null)

  user_lines+=("Proje dışı dizin: $(short_path "$cwd"). Global kurallar, formatter ve ADR yapısı aktif.")
  [ ${#lines[@]} -gt 0 ] && user_lines+=("Son çalışılan projeler:" "$(printf '  %s\n' "${lines[@]}")")
  model_lines=("${user_lines[@]}")
}

# ---------- Ana akış ----------
git_root=$(git rev-parse --show-toplevel 2>/dev/null)

if [ "$cwd" = "$HOME" ]; then
  show_overview
elif [ -n "$git_root" ]; then
  describe_repo "$git_root" "$(basename "$git_root")" single
elif has_marker "$cwd"; then
  describe_repo "$cwd" "$(basename "$cwd")" single
else
  mapfile -t found < <(find_repos "$cwd" 1)
  # Git deposu varsa yalnızca onları göster; git'siz klasörler (arşiv, kopya) kalabalık yapar.
  repos=()
  for r in "${found[@]}"; do is_git_root "$r" && repos+=("$r"); done
  [ ${#repos[@]} -eq 0 ] && repos=("${found[@]}")
  if [ ${#repos[@]} -eq 0 ]; then
    show_overview
  else
    user_lines+=("Çalışma alanı: $(short_path "$cwd") (${#repos[@]} depo/proje)")
    model_lines+=("Çalışma alanı: $(short_path "$cwd"). Aşağıdaki depoların her biri ayrı; komutları ilgili deponun dizininde çalıştır, ADR'yi ilgili deponun ADR klasörüne yaz.")
    for r in "${repos[@]}"; do
      describe_repo "$r" "${r#$cwd/}" multi
    done
  fi
fi

if [ "$source_type" = "compact" ]; then
  model_lines+=("" "Hatırlatma (context sıkıştırıldı): ~/.claude/CLAUDE.md kuralları geçerli. TDD (geliştirirken sadece ilgili testler, sonda bir kez full suite), karar gerektiren işlerde Türkçe ADR, commit/PR'da yapay zekâ ismi yok. Yanıt biçimi (§0): ilk satır cevap, dolgu yok, çok adımlı işte numaralı liste ve durum, emoji yok.")
fi

jq -n --arg u "$(printf '%s\n' "${user_lines[@]}")" --arg m "$(printf '%s\n' "${model_lines[@]}")" '{
  systemMessage: $u,
  hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: $m }
}'
exit 0
