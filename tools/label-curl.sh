#!/usr/bin/env bash
#
# Запрос ярлыка напрямую через curl, минуя панель: видно, отдаёт ли API
# нужный размер другому клиенту. Токен берётся из настроек установленной панели.
#
#   bash tools/label-curl.sh <request_id> [размер]
#   bash tools/label-curl.sh 62368989348d46f2afa0dd0091c52707-udp 58x40
#
set -euo pipefail

REQUEST_ID=${1:-}
SIZE=${2:-58x40}
API_BASE=${API_BASE:-https://b2b-authproxy.taxi.yandex.net}
DIR=${DIR:-/opt/anex-orders}
OUT=${OUT:-/tmp}

[[ -n "$REQUEST_ID" ]] || { echo "Использование: bash $0 <request_id> [размер]" >&2; exit 1; }

# Токен: сначала введённый в панели, иначе из .env — как это делает сама панель.
token_from_settings() {
  local file="$DIR/config/settings.json"
  [[ -f "$file" ]] || return 1
  sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]\+\)".*/\1/p' "$file" | head -1
}
token_from_env() {
  local file="$DIR/.env"
  [[ -f "$file" ]] || return 1
  sed -n 's/^YANDEX_OAUTH_TOKEN=//p' "$file" | head -1
}

TOKEN=${TOKEN:-$(token_from_settings || true)}
[[ -n "${TOKEN:-}" ]] || TOKEN=$(token_from_env || true)
[[ -n "${TOKEN:-}" ]] || { echo "Не нашёл токен в $DIR — задайте его переменной TOKEN=..." >&2; exit 1; }

# Размер страницы полученного PDF в миллиметрах.
page_size() {
  node -e '
    const { readFileSync } = require("node:fs");
    const head = readFileSync(process.argv[1]).subarray(0, 262144).toString("latin1");
    const m = head.match(/\/MediaBox\s*\[\s*([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s*\]/);
    if (!m) return console.log("размер не прочитан");
    const mm = (a, b) => Math.round(Math.abs(b - a) / (72 / 25.4));
    console.log(mm(+m[1], +m[3]) + "x" + mm(+m[2], +m[4]) + " мм");
  ' "$1"
}

ask() {
  local label="$1" body="$2" file="$OUT/label-$3.pdf" code
  code=$(curl -s -o "$file" -w '%{http_code}' -X POST "$API_BASE/api/b2b/platform/request/generate-labels" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$body")

  printf '%-28s HTTP %s' "$label" "$code"
  if [[ "$code" == "200" ]]; then
    printf ', страница: %s, файл: %s\n' "$(page_size "$file")" "$file"
  else
    printf '\n  ответ: %s\n' "$(head -c 300 "$file")"
  fi
}

echo "Хост:   $API_BASE"
echo "Заказ:  $REQUEST_ID"
echo "Размер: $SIZE"
echo

ask "массив (как шлёт панель)" "{\"request_ids\":[\"$REQUEST_ID\"],\"label_size_mm\":\"$SIZE\",\"language\":\"ru\"}" "array"
ask "строкой (пример из доков)" "{\"request_ids\":\"$REQUEST_ID\",\"label_size_mm\":\"$SIZE\",\"language\":\"ru\"}" "string"
ask "с generate_type: one" "{\"request_ids\":[\"$REQUEST_ID\"],\"generate_type\":\"one\",\"label_size_mm\":\"$SIZE\",\"language\":\"ru\"}" "gentype"
