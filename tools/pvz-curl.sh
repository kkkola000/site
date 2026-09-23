#!/usr/bin/env bash
#
# Что API отвечает про пункт выдачи: панель показывает «ПВЗ <идентификатор>»,
# когда адрес точки найти не удалось. Скрипт спрашивает API напрямую и печатает
# ответы — по ним видно, какое поле фильтра и какой список ждёт Яндекс.
#
#   bash tools/pvz-curl.sh <request_id> [platform_id ПВЗ]
#   bash tools/pvz-curl.sh 62368989348d46f2afa0dd0091c52707-udp
#
set -euo pipefail

REQUEST_ID=${1:-}
PVZ_ID=${2:-}
API_BASE=${API_BASE:-https://b2b-authproxy.taxi.yandex.net}
DIR=${DIR:-/opt/anex-orders}

[[ -n "$REQUEST_ID" || -n "$PVZ_ID" ]] || {
  echo "Использование: bash $0 <request_id> [platform_id ПВЗ]" >&2
  exit 1
}

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

# Красивый JSON, если есть node; иначе как пришло.
pretty() {
  if command -v node >/dev/null; then
    node -e '
      let raw = "";
      process.stdin.on("data", (c) => (raw += c)).on("end", () => {
        try {
          console.log(JSON.stringify(JSON.parse(raw), null, 2).slice(0, Number(process.argv[1] || 1500)));
        } catch {
          console.log(raw.slice(0, 500));
        }
      });
    ' "${1:-1500}"
  else
    head -c 500
  fi
}

post() {
  local label="$1" path="$2" body="$3" limit="${4:-1200}" out code
  out=$(mktemp)
  code=$(curl -s -o "$out" -w '%{http_code}' -X POST "$API_BASE$path" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$body")
  echo "--- $label — HTTP $code"
  echo "    тело запроса: $body"
  pretty "$limit" < "$out" | sed 's/^/    /'
  rm -f "$out"
  echo
}

echo "Хост: $API_BASE"
echo

if [[ -n "$REQUEST_ID" ]]; then
  echo "=== Куда едет заказ (request/info → request.destination) ==="
  out=$(mktemp)
  code=$(curl -s -o "$out" -w '%{http_code}' -G "$API_BASE/api/b2b/platform/request/info" \
    --data-urlencode "request_id=$REQUEST_ID" -H "Authorization: Bearer $TOKEN")
  echo "--- HTTP $code"
  if command -v node >/dev/null; then
    node -e '
      const { readFileSync } = require("node:fs");
      try {
        const data = JSON.parse(readFileSync(process.argv[1], "utf8"));
        const destination = data?.request?.destination ?? data?.destination ?? null;
        console.log(JSON.stringify(destination, null, 2).slice(0, 1500));
      } catch (err) {
        console.log(readFileSync(process.argv[1], "utf8").slice(0, 500));
      }
    ' "$out" | sed 's/^/    /'
    [[ -n "$PVZ_ID" ]] || PVZ_ID=$(node -e '
      const { readFileSync } = require("node:fs");
      try {
        const data = JSON.parse(readFileSync(process.argv[1], "utf8"));
        process.stdout.write(String(data?.request?.destination?.platform_station?.platform_id || ""));
      } catch {}
    ' "$out")
  else
    head -c 800 "$out" | sed 's/^/    /'
  fi
  rm -f "$out"
  echo
fi

[[ -n "$PVZ_ID" ]] || { echo "Идентификатор ПВЗ не найден — передайте его вторым аргументом." >&2; exit 1; }
echo "Пункт выдачи: $PVZ_ID"
echo

echo "=== Список ПВЗ: какое поле фильтра принимает API ==="
post "pickup_points_ids (так шлёт панель)" /api/b2b/platform/pickup-points/list "{\"pickup_points_ids\":[\"$PVZ_ID\"]}"
post "platform_station_ids"                /api/b2b/platform/pickup-points/list "{\"platform_station_ids\":[\"$PVZ_ID\"]}"
post "pickup_point_ids"                    /api/b2b/platform/pickup-points/list "{\"pickup_point_ids\":[\"$PVZ_ID\"]}"
# Пустое тело: если фильтры не поддерживаются, в ответе будет весь список —
# по первой записи видно, как названы поля точки.
post "без фильтра (первые строки ответа)"  /api/b2b/platform/pickup-points/list "{}" 800

echo "=== Точка как склад ==="
post "warehouses/retrieve" /api/b2b/platform/warehouses/retrieve "{\"station_id\":\"$PVZ_ID\"}"
