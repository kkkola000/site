#!/usr/bin/env bash
#
# Развёртывание панели заказов на сервере (Debian/Ubuntu, systemd).
#
#   sudo bash deploy/deploy.sh --token <OAuth-токен> [--domain orders.example.com] [--ssl]
#
# Скрипт идемпотентен: повторный запуск обновляет файлы и перезапускает сервис,
# не затирая уже настроенный .env.
#
set -euo pipefail

SERVICE="anex-orders"
# Соседняя панель на этом же сервере: Ozon Pack (/opt/ozon-pack, порт 8080,
# служба ozon-pack, доступ ограничен подсетью VPN). Её файлы мы не трогаем.
OZON_DIR="/opt/ozon-pack"
OZON_SNIPPET="/etc/nginx/snippets/ozon-pack-access.conf"
ACCESS_SNIPPET="/etc/nginx/snippets/anex-orders-access.conf"
ALLOW_SUBNETS=""
ATTACH_SITE=""      # auto | путь к файлу сайта nginx
DETACH_SITE=0
MARK_BEGIN="# >>> anex-orders: панель заказов (добавлено deploy.sh) >>>"
MARK_END="# <<< anex-orders <<<"
DIR="/opt/anex-orders"
RUN_USER="anexorders"
PORT="3010"
BASE_PATH=""
DOMAIN=""
TOKEN=""
STATION_IDS=""
AUTH_USER="manager"
AUTH_PASSWORD=""
# На сервере nginx уже настроен под другую панель, поэтому по умолчанию
# его конфигурация не трогается: печатаем готовый блок для ручной вставки.
WITH_NGINX=0
WITH_SSL=0
SSL_EMAIL=""
NODE_MAJOR="20"

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  !\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mОшибка:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<USAGE
Развёртывание панели интернет-заказов (Яндекс Доставка, боевой контур).

Использование: sudo bash deploy/deploy.sh [опции]

  --token <строка>      OAuth-токен Яндекс Доставки. Указывать необязательно:
                        его можно ввести прямо в панели, в разделе «Настройки».
  --stations <id,id>    platform_station_id складов отгрузки (фильтр выборки).
  --port <порт>         Локальный порт сервиса (по умолчанию ${PORT}).
  --base-path <путь>    Подпуть, если панель встраивается в существующий домен,
                        например: --base-path /orders
  --dir <путь>          Каталог установки (по умолчанию ${DIR}).
  --user <имя>          Системный пользователь сервиса (по умолчанию ${RUN_USER}).
  --auth-user <имя>     Логин для входа в панель (по умолчанию ${AUTH_USER}).
  --auth-password <..>  Пароль панели. Если не задан — будет сгенерирован.
  --allow-subnet <сеть> Кому открыт доступ через nginx, например 10.66.66.0/24.
                        Можно указать несколько раз. Если не задано — берётся
                        список из соседней панели Ozon Pack (VPN-подсеть).
  --bind <адрес>        Слушать этот адрес напрямую, без nginx. Например
                        --bind 10.66.66.1 — вход по http://10.66.66.1:ПОРТ
  --attach-site auto    Добавить путь в уже работающий сайт nginx: панель
                        откроется по адресу этого сайта + --base-path.
                        Вместо auto можно указать путь к файлу конфигурации.
  --detach-site         Убрать ранее добавленный путь из сайта nginx.
  --list-sites          Показать сайты nginx на сервере и выйти.

nginx на сервере уже настроен, поэтому по умолчанию скрипт его НЕ меняет:
в конце печатается готовый блок конфигурации для вставки вручную.

  --nginx --domain <домен>  Создать отдельный сайт nginx для этого домена
                            (существующие сайты не затрагиваются).
  --ssl                     Выпустить сертификат Let's Encrypt (нужен публичный
                            доступ к серверу; при входе по VPN не требуется).
  --ssl-email <почта>       Контакт для Let's Encrypt.
  -h, --help                Эта справка.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --token) TOKEN="${2:-}"; shift 2 ;;
    --stations) STATION_IDS="${2:-}"; shift 2 ;;
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --base-path) BASE_PATH="${2:-}"; shift 2 ;;
    --nginx) WITH_NGINX=1; shift ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --dir) DIR="${2:-}"; shift 2 ;;
    --user) RUN_USER="${2:-}"; shift 2 ;;
    --auth-user) AUTH_USER="${2:-}"; shift 2 ;;
    --auth-password) AUTH_PASSWORD="${2:-}"; shift 2 ;;
    --allow-subnet) ALLOW_SUBNETS="${ALLOW_SUBNETS:+$ALLOW_SUBNETS,}${2:-}"; shift 2 ;;
    --bind) BIND_HOST="${2:-}"; shift 2 ;;
    --attach-site) ATTACH_SITE="${2:-auto}"; shift 2 ;;
    --detach-site) DETACH_SITE=1; shift ;;
    --list-sites) LIST_SITES=1; shift ;;
    --ssl) WITH_SSL=1; shift ;;
    --ssl-email) SSL_EMAIL="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "неизвестный аргумент: $1 (--help для справки)" ;;
  esac
done

# DEPLOY_LIB_ONLY=1 — подключить функции (например, из тестов), ничего не устанавливая.
if [[ "${DEPLOY_LIB_ONLY:-0}" != "1" ]]; then
  [[ $EUID -eq 0 ]] || die "запустите с правами root: sudo bash deploy/deploy.sh ..."
  [[ -f "$SRC/server/index.js" ]] || die "не найден исходный код панели в $SRC"
  command -v systemctl >/dev/null || die "нужен systemd"
  if [[ $WITH_SSL -eq 1 && -z "$DOMAIN" ]]; then die "--ssl требует --domain"; fi
  if [[ $WITH_NGINX -eq 1 && -z "$DOMAIN" ]]; then die "--nginx требует --domain"; fi

  # Порт не должен быть занят соседней панелью на этом же сервере.
  if command -v ss >/dev/null && ss -ltn "sport = :${PORT}" 2>/dev/null | grep -q LISTEN; then
    if ! systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
      die "порт ${PORT} уже занят другим сервисом — укажите свободный: --port 3011"
    fi
  fi
fi

# ---------- 0. Соседняя панель Ozon Pack ----------
# Ozon Pack держит свой каталог, службу, порт и сайт nginx. Задача — убедиться,
# что мы ничего из этого не занимаем и не переписываем.
neighbour_port() {
  local port=""
  [[ -f "$OZON_DIR/.env" ]] && port="$(read_env "$OZON_DIR/.env" PORT)"
  echo "${port:-8080}"
}

# Список разрешённых сетей соседа: сначала IP_ALLOWLIST из .env, иначе
# разбираем директивы allow в его снипете nginx.
neighbour_allowlist() {
  local list=""
  [[ -f "$OZON_DIR/.env" ]] && list="$(read_env "$OZON_DIR/.env" IP_ALLOWLIST)"
  if [[ -z "$list" && -f "$OZON_SNIPPET" ]]; then
    # localhost и all в список сетей не берём: он нужен для сообщения
    # оператору и для сравнения, а свои allow мы всё равно пишем сами.
    list="$(awk '/^[[:space:]]*allow[[:space:]]/ {
        gsub(/;/, "", $2)
        if ($2 == "all" || $2 == "127.0.0.1" || $2 == "::1") next
        printf "%s%s", (n++ ? "," : ""), $2
      }' "$OZON_SNIPPET")"
  fi
  echo "$list"
}

check_neighbour() {
  [[ -d "$OZON_DIR" ]] || systemctl list-unit-files 2>/dev/null | grep -q '^ozon-pack\.service' || return 0

  local oport; oport="$(neighbour_port)"
  log "Рядом работает панель Ozon Pack"
  ok "каталог ${OZON_DIR}, служба ozon-pack, порт ${oport}"

  [[ "$PORT" == "$oport" ]] && die "порт ${PORT} занят панелью Ozon Pack — выберите другой: --port 3010"
  [[ "$DIR" == "$OZON_DIR" ]] && die "каталог ${DIR} принадлежит Ozon Pack — укажите другой: --dir /opt/anex-orders"
  [[ "$SERVICE" == "ozon-pack" ]] && die "имя службы совпадает с Ozon Pack"
  [[ "$RUN_USER" == "ozon" ]] && die "пользователь ozon принадлежит Ozon Pack — укажите другой: --user anexorders"

  # Его сайт nginx пересоздаётся его же скриптом ssl.sh целиком, поэтому
  # наши правки в этом файле пропадут при следующем запуске их установки.
  local their_site
  their_site="$(grep -rlsE "proxy_pass http://127\.0\.0\.1:${oport}" /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null | head -1 || true)"
  if [[ -n "$their_site" ]]; then
    ok "сайт nginx соседа: ${their_site} (не трогаем)"
    if [[ -n "$DOMAIN" ]] && grep -qsE "server_name[^;]*\b${DOMAIN}\b" "$their_site"; then
      die "домен ${DOMAIN} обслуживает Ozon Pack; его конфиг перезаписывается скриптом ssl.sh — возьмите отдельный поддомен"
    fi
  fi

  if [[ $WITH_SSL -eq 1 ]] && systemctl list-unit-files 2>/dev/null | grep -q '^certbot-renew\.timer'; then
    warn "у Ozon Pack уже настроено продление сертификатов (certbot-renew.timer)"
    warn "при доступе по VPN сертификат Let's Encrypt не нужен — рассмотрите запуск без --ssl"
  fi
}

# ---------- 1. Node.js ----------
install_node() {
  log "Проверяю Node.js"
  local current=""
  if command -v node >/dev/null; then current="$(node -v | sed 's/^v//;s/\..*//')"; fi
  if [[ -n "$current" && "$current" -ge "$NODE_MAJOR" ]]; then
    ok "Node.js $(node -v) уже установлен"
    return
  fi
  command -v apt-get >/dev/null || die "нужен Node.js ${NODE_MAJOR}+; на этой ОС установите его вручную"
  log "Ставлю Node.js ${NODE_MAJOR} из NodeSource"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates gnupg >/dev/null
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  ok "Установлен Node.js $(node -v)"
}

# ---------- 2. Пользователь и файлы ----------
install_files() {
  log "Готовлю пользователя и каталог"
  id -u "$RUN_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DIR" --shell /usr/sbin/nologin "$RUN_USER"
  mkdir -p "$DIR"

  # Копируем только рабочие файлы: без .git, node_modules и локального .env.
  if command -v rsync >/dev/null; then
    rsync -a --delete \
      --exclude '.git' --exclude 'node_modules' --exclude '.env' --exclude 'config/stations.json' \
      "$SRC"/ "$DIR"/
  else
    for path in server public config deploy package.json .env.example README.md; do
      [[ -e "$SRC/$path" ]] && cp -a "$SRC/$path" "$DIR/"
    done
  fi
  mkdir -p "$DIR/config"
  ok "Код в $DIR"
}

# ---------- 3. Конфигурация ----------
write_env() {
  log "Настраиваю .env"
  local env_file="$DIR/.env"

  if [[ -f "$env_file" ]]; then
    # Обновляем только переданные значения, остальное сохраняем.
    [[ -n "$TOKEN" ]] && set_env "$env_file" YANDEX_OAUTH_TOKEN "$TOKEN"
    [[ -n "$STATION_IDS" ]] && set_env "$env_file" YANDEX_STATION_IDS "$STATION_IDS"
    [[ -n "$AUTH_PASSWORD" ]] && set_env "$env_file" AUTH_PASSWORD "$AUTH_PASSWORD"
    set_env "$env_file" PORT "$PORT"
    set_env "$env_file" BASE_PATH "$BASE_PATH"
    ok ".env обновлён (существующие значения сохранены)"
  else
    [[ -n "$AUTH_PASSWORD" ]] || { AUTH_PASSWORD="$(head -c 12 /dev/urandom | base64 | tr -d '/+=' | head -c 14)"; GENERATED_PASSWORD=1; }
    cp "$DIR/.env.example" "$env_file"
    set_env "$env_file" PORT "$PORT"
    set_env "$env_file" HOST "127.0.0.1"
    set_env "$env_file" AUTH_USER "$AUTH_USER"
    set_env "$env_file" AUTH_PASSWORD "$AUTH_PASSWORD"
    set_env "$env_file" YANDEX_OAUTH_TOKEN "$TOKEN"
    set_env "$env_file" YANDEX_STATION_IDS "$STATION_IDS"
    set_env "$env_file" BASE_PATH "$BASE_PATH"
    ok ".env создан"
  fi

  # По умолчанию панель слушает localhost и публикуется через nginx.
  # С --bind она слушает указанный адрес (например, адрес сервера в туннеле).
  set_env "$env_file" HOST "${BIND_HOST:-127.0.0.1}"

  grep -q '^YANDEX_OAUTH_TOKEN=.\+' "$env_file" || TOKEN_FROM_PANEL=1

  # Дальше работаем с фактическими значениями из .env: при обновлении
  # логин и пароль могли быть заданы в прошлый раз.
  AUTH_USER="$(read_env "$env_file" AUTH_USER)"
  AUTH_PASSWORD="$(read_env "$env_file" AUTH_PASSWORD)"

  chown -R "$RUN_USER":"$RUN_USER" "$DIR"
  chmod 600 "$env_file"   # в файле токен и пароль панели
}

read_env() {
  grep -m1 "^${2}=" "$1" 2>/dev/null | cut -d= -f2- || true
}

set_env() {
  local file="$1" key="$2" value="$3"
  if grep -q "^${key}=" "$file"; then
    # Значение подставляем через awk, чтобы не экранировать спецсимволы sed.
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' "$file" > "$file.tmp"
    mv "$file.tmp" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

# ---------- 4. systemd ----------
install_service() {
  log "Ставлю сервис systemd"
  local unit="/etc/systemd/system/${SERVICE}.service"
  sed -e "s|__USER__|${RUN_USER}|g" \
      -e "s|__DIR__|${DIR}|g" \
      -e "s|__NODE__|$(command -v node)|g" \
      -e "s|__SERVICE__|${SERVICE}|g" \
      "$DIR/deploy/orders-panel.service" > "$unit"
  systemctl daemon-reload
  systemctl enable "$SERVICE" >/dev/null 2>&1
  systemctl restart "$SERVICE"
  ok "Сервис ${SERVICE} запущен"
}

# ---------- 5. nginx ----------
# Приводит запись сети к виду, который принимает nginx: 10.66.66.2/24 → 10.66.66.0/24.
# Директива allow с ненулевыми битами хоста роняет проверку конфига («low address
# bits are meaningless»), а nginx на сервере общий с панелью Ozon Pack.
normalize_cidr() {
  local entry="$1" ip prefix a b c d num mask net
  entry="$(printf '%s' "$entry" | tr -d ' ')"
  [[ -z "$entry" ]] && return 1
  # IPv6 и прочее отдаём как есть — считаем только IPv4.
  [[ "$entry" == *:* ]] && { printf '%s' "$entry"; return 0; }

  ip="${entry%%/*}"
  prefix="${entry#*/}"
  [[ "$prefix" == "$entry" ]] && prefix=32
  [[ "$prefix" =~ ^[0-9]+$ ]] && [[ "$prefix" -le 32 ]] || return 1
  [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1

  IFS=. read -r a b c d <<< "$ip"
  for octet in "$a" "$b" "$c" "$d"; do [[ "$octet" -le 255 ]] || return 1; done

  num=$(( (a << 24) | (b << 16) | (c << 8) | d ))
  if [[ "$prefix" -eq 0 ]]; then mask=0; else mask=$(( (0xFFFFFFFF << (32 - prefix)) & 0xFFFFFFFF )); fi
  net=$(( num & mask ))
  printf '%d.%d.%d.%d/%d' $(( (net >> 24) & 255 )) $(( (net >> 16) & 255 )) $(( (net >> 8) & 255 )) $(( net & 255 )) "$prefix"
}

# Свой файл правил доступа: снипет соседа принадлежит его скриптам,
# поэтому копируем из него только список сетей.
write_access_snippet() {
  # Порядок источников: флаг запуска → сохранённый список → сети соседней панели.
  # Без сохранённого списка повторный запуск без флага открыл бы панель всем.
  local list="$ALLOW_SUBNETS"
  if [[ -z "$list" && -f "$DIR/.env" ]]; then
    list="$(read_env "$DIR/.env" ALLOW_SUBNETS)"
  fi
  [[ -n "$list" ]] || list="$(neighbour_allowlist)"

  # Нормализуем и отбрасываем мусор: в nginx попадает только проверенное.
  local normalized="" item
  while IFS= read -r item; do
    [[ -z "$item" ]] && continue
    case "$item" in 127.0.0.1|::1|all) continue ;; esac
    if net="$(normalize_cidr "$item")"; then
      [[ "$net" != "$item" ]] && info_normalized="${info_normalized:+$info_normalized, }${item} → ${net}"
      normalized="${normalized:+$normalized,}$net"
    else
      warn "не разобрал сеть «${item}» — пропускаю"
    fi
  done < <(printf '%s\n' "$list" | tr ',' '\n')
  [[ -n "${info_normalized:-}" ]] && ok "приведено к виду сети: ${info_normalized}"
  list="$normalized"

  mkdir -p "$(dirname "$ACCESS_SNIPPET")"
  {
    echo "# Кто может открывать панель заказов. Создано deploy/deploy.sh."
    echo "allow 127.0.0.1;"
    echo "allow ::1;"
    if [[ -n "$list" ]]; then
      printf '%s\n' "$list" | tr ',' '\n' | while read -r net; do
        [[ -n "$net" ]] && echo "allow $net;"
      done
      echo "deny all;"
    else
      echo "# Список сетей не задан — вход ограничен только паролем панели."
      echo "# Ограничить доступ сетью VPN: --allow-subnet 10.8.0.0/24"
      echo "allow all;"
    fi
  } > "$ACCESS_SNIPPET"

  # Сохраняем список, чтобы повторный запуск без флага не открыл панель.
  if [[ -n "$list" && -f "$DIR/.env" ]]; then
    set_env "$DIR/.env" ALLOW_SUBNETS "$list"
    chown "$RUN_USER":"$RUN_USER" "$DIR/.env" 2>/dev/null || true
  fi

  if [[ -n "$list" ]]; then
    ok "доступ разрешён сетям: ${list}"
  else
    warn "сети VPN не найдены — сайт открыт всем, кто дойдёт до nginx (пароль панели остаётся)"
  fi
}

# Блок location для вставки в чужой сайт nginx.
location_block() {
  cat <<BLOCK
$MARK_BEGIN
    location ${BASE_PATH}/ {
        include ${ACCESS_SNIPPET};
        proxy_pass http://127.0.0.1:${PORT}${BASE_PATH}/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }
    location = ${BASE_PATH} { return 301 ${BASE_PATH}/; }
$MARK_END
BLOCK
}

# Убирает ранее вставленный блок (между маркерами).
strip_block() {
  awk -v b="$MARK_BEGIN" -v e="$MARK_END" '
    index($0, b) { skip = 1 }
    !skip { print }
    index($0, e) { skip = 0 }
  ' "$1"
}

# Вставляет блок перед закрывающей скобкой того server{}, который проксирует
# на соседнюю панель. Другие блоки (редирект на https, acme) не трогаем.
insert_block() {
  local file="$1" port="$2" block="$3"
  awk -v port="$port" -v block="$block" '
    /^[[:space:]]*server[[:space:]]*\{/ && depth == 0 { inblock = 1; buf = ""; hit = 0 }
    {
      if (inblock) {
        buf = buf $0 "\n"
        if ($0 ~ ("proxy_pass[[:space:]]+http://127\\.0\\.0\\.1:" port)) hit = 1
        n = gsub(/\{/, "{"); depth += n
        n = gsub(/\}/, "}"); depth -= n
        if (depth <= 0) {
          if (hit) {
            # Вставляем перед последней скобкой блока.
            sub(/\}[[:space:]]*\n$/, "", buf)
            printf "%s%s\n}\n", buf, block
          } else {
            printf "%s", buf
          }
          inblock = 0; depth = 0; next
        }
        next
      }
      print
    }
  ' "$file"
}

# Карта конфигурации nginx: какой файл какой server_name обслуживает и куда
# проксирует. Берём из nginx -T — это действующая конфигурация со всеми include,
# включая Plesk и прочие нестандартные размещения.
nginx_map() {
  nginx -T 2>/dev/null | awk '
    /^# configuration file / { file = $4; sub(/:$/, "", file); next }
    /^[[:space:]]*server_name[[:space:]]/ {
      line = $0; sub(/^[[:space:]]*server_name[[:space:]]+/, "", line); gsub(/;/, "", line)
      print file "\tname\t" line; next
    }
    /^[[:space:]]*proxy_pass[[:space:]]/ {
      line = $0; sub(/^[[:space:]]*proxy_pass[[:space:]]+/, "", line); gsub(/;/, "", line)
      print file "\tproxy\t" line
    }
  '
}

list_sites() {
  log "Сайты nginx на сервере"
  local map; map="$(nginx_map)"
  if [[ -z "$map" ]]; then
    warn "nginx -T ничего не вернул (nginx не установлен или не запущен)"
    return
  fi
  awk -F'\t' '$2 == "name" { printf "  %-46s %s\n", $3, $1 }' <<< "$map" | sort -u
  echo
  awk -F'\t' '$2 == "proxy" { printf "  → %-44s %s\n", $3, $1 }' <<< "$map" | sort -u
}

# Plesk сам пересобирает конфиги доменов, поэтому свои директивы туда кладут
# отдельным файлом vhost_nginx.conf — он переживает пересборку.
plesk_vhost_file() {
  local domain="$1"
  [[ -n "$domain" ]] || return 1
  local dir="/var/www/vhosts/system/${domain}/conf"
  [[ -d "$dir" ]] || return 1
  echo "${dir}/vhost_nginx.conf"
}

# Ищем файл сайта: явный путь → по домену → по порту соседней панели.
resolve_site_file() {
  local explicit="$1" domain="$2" port="$3" map file

  if [[ -n "$explicit" && "$explicit" != "auto" ]]; then
    [[ -f "$explicit" ]] || die "файл сайта не найден: $explicit"
    echo "$explicit"
    return 0
  fi

  map="$(nginx_map)"
  [[ -n "$map" ]] || die "не удалось прочитать конфигурацию nginx (nginx -T)"

  if [[ -n "$domain" ]]; then
    file="$(awk -F'\t' -v d="$domain" '$2 == "name" && index(" " $3 " ", " " d " ") { print $1; exit }' <<< "$map")"
    [[ -n "$file" ]] && { echo "$file"; return 0; }
  fi

  file="$(awk -F'\t' -v p="127.0.0.1:${port}" '$2 == "proxy" && index($3, p) { print $1; exit }' <<< "$map")"
  [[ -n "$file" ]] && { echo "$file"; return 0; }

  return 1
}

attach_to_site() {
  local target oport
  oport="$(neighbour_port)"

  if ! target="$(resolve_site_file "$ATTACH_SITE" "$DOMAIN" "$oport")"; then
    echo
    list_sites
    echo
    die "не понял, в какой сайт встраивать панель. Укажите домен (--domain seller.anex-online.kz) или файл (--attach-site /путь/к/конфигу) из списка выше"
  fi

  [[ -n "$BASE_PATH" ]] || die "нужен путь: --base-path /anex-orders"
  write_access_snippet

  # Plesk: свои директивы кладём в отдельный файл домена, чужой конфиг не трогаем.
  local plesk_file=""
  if plesk_file="$(plesk_vhost_file "$DOMAIN")"; then
    attach_plesk "$plesk_file"
    return
  fi

  log "Добавляю путь ${BASE_PATH} в сайт ${target}"
  cp -a "$target" "${target}.anex-orders.bak"

  local tmp; tmp="$(mktemp)"
  strip_block "$target" > "$tmp"     # вставка идемпотентна: старый блок убираем

  if [[ $DETACH_SITE -eq 0 ]]; then
    local with_block
    with_block="$(insert_block "$tmp" "$oport" "$(location_block)")"
    if ! grep -q "$MARK_BEGIN" <<< "$with_block"; then
      rm -f "$tmp"
      echo
      list_sites
      die "в ${target} нет блока server{}, который проксирует на 127.0.0.1:${oport} — укажите файл явно через --attach-site"
    fi
    printf '%s\n' "$with_block" > "$tmp"
  fi

  cat "$tmp" > "$target"
  rm -f "$tmp"
  reload_or_rollback "$target" "${target}.anex-orders.bak"
}

attach_plesk() {
  local file="$1" dir
  dir="$(dirname "$file")"
  log "Plesk: пишу директивы домена в ${file}"
  mkdir -p "$dir"
  [[ -f "$file" ]] && cp -a "$file" "${file}.anex-orders.bak" || : > "${file}.anex-orders.bak"

  local tmp; tmp="$(mktemp)"
  [[ -f "$file" ]] && strip_block "$file" > "$tmp" || : > "$tmp"
  [[ $DETACH_SITE -eq 0 ]] && location_block >> "$tmp"
  cat "$tmp" > "$file"
  rm -f "$tmp"

  if command -v plesk >/dev/null; then
    plesk sbin httpdmng --reconfigure-domain "$DOMAIN" >/dev/null 2>&1 || warn "не удалось пересобрать конфигурацию домена в Plesk"
  fi
  reload_or_rollback "$file" "${file}.anex-orders.bak"
}

reload_or_rollback() {
  local file="$1" backup="$2"
  if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx 2>/dev/null || nginx -s reload 2>/dev/null || true
    if [[ $DETACH_SITE -eq 1 ]]; then
      ok "путь убран из ${file}"
    else
      ok "панель доступна по пути ${BASE_PATH}/"
      warn "если конфиг сайта пересоздаст его собственный скрипт — повторите эту команду"
    fi
  else
    cp -a "$backup" "$file"
    nginx -t || true
    die "конфигурация nginx не прошла проверку — файл возвращён как был"
  fi
}

install_nginx() {
  if [[ $WITH_NGINX -ne 1 ]]; then
    warn "nginx не настраивается (на сервере уже есть своя конфигурация) — блок для вставки будет ниже"
    return
  fi

  log "Добавляю отдельный сайт nginx для ${DOMAIN}"
  command -v nginx >/dev/null || die "nginx не установлен"

  local site="/etc/nginx/sites-available/${SERVICE}"
  if grep -rlsE "server_name[^;]*\b${DOMAIN}\b" /etc/nginx/sites-enabled/ 2>/dev/null | grep -qv "${SERVICE}"; then
    die "домен ${DOMAIN} уже используется другим сайтом nginx — вставьте блок вручную (печатается ниже)"
  fi

  write_access_snippet
  sed -e "s|__DOMAIN__|${DOMAIN}|g" -e "s|__PORT__|${PORT}|g" -e "s|__SERVICE__|${SERVICE}|g" \
      -e "s|__ACCESS_SNIPPET__|${ACCESS_SNIPPET}|g" \
    "$DIR/deploy/nginx.conf" > "$site"
  ln -sf "$site" "/etc/nginx/sites-enabled/${SERVICE}"
  # Чужие сайты (включая default) не трогаем — на сервере работает другая панель.
  nginx -t >/dev/null 2>&1 || { rm -f "/etc/nginx/sites-enabled/${SERVICE}"; die "конфигурация nginx не прошла проверку (nginx -t)"; }
  systemctl reload nginx
  ok "nginx: ${DOMAIN} → 127.0.0.1:${PORT}"

  if [[ $WITH_SSL -eq 1 ]]; then
    log "Выпускаю сертификат Let's Encrypt"
    command -v certbot >/dev/null || apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
    local args=(--nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect)
    if [[ -n "$SSL_EMAIL" ]]; then args+=(-m "$SSL_EMAIL"); else args+=(--register-unsafely-without-email); fi
    certbot "${args[@]}" || warn "certbot не выпустил сертификат — проверьте DNS и доступность сервера снаружи"
  fi
}

# Готовый блок для существующего конфига nginx: панель встраивается
# либо в отдельный server{}, либо подпутём в уже работающий сайт.
print_nginx_snippet() {
  echo
  log "Как опубликовать панель через уже настроенный nginx"
  if [[ -n "$BASE_PATH" ]]; then
    cat <<SNIPPET
  ВАЖНО: не добавляйте этот блок в сайт панели Ozon Pack — его конфиг
  пересоздаётся скриптом deploy/ssl.sh, и правка пропадёт. Используйте
  отдельный сайт nginx (свой поддомен) либо сайт, который вы ведёте сами.

  В такой server{} добавьте:

    location ${BASE_PATH}/ {
        include ${ACCESS_SNIPPET};   # те же сети VPN, что и у Ozon Pack
        proxy_pass http://127.0.0.1:${PORT}${BASE_PATH}/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }
    location = ${BASE_PATH} { return 301 ${BASE_PATH}/; }

  Затем: nginx -t && systemctl reload nginx
SNIPPET
  else
    cat <<SNIPPET
  Вариант 1 — отдельный поддомен: добавьте сайт из ${DIR}/deploy/nginx.conf
    (подставьте домен и порт ${PORT}), включите его симлинком в sites-enabled.

  Вариант 2 — подпуть в существующем сайте: переразверните с указанием пути,
    например: sudo bash deploy/deploy.sh --base-path /orders --port ${PORT}
    и вставьте location-блок, который скрипт напечатает.

  Затем: nginx -t && systemctl reload nginx
SNIPPET
  fi
}

# ---------- 6. Проверка ----------
health_check() {
  log "Проверяю, что панель отвечает"
  local auth=()
  [[ -n "$AUTH_PASSWORD" ]] && auth=(-u "${AUTH_USER}:${AUTH_PASSWORD}")
  for _ in $(seq 1 15); do
    if curl -fsS -m 3 "${auth[@]}" "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
      ok "Панель отвечает на http://127.0.0.1:${PORT}"
      return 0
    fi
    sleep 1
  done
  warn "панель не ответила за 15 с — смотрите журнал: journalctl -u ${SERVICE} -n 50"
  return 0
}

if [[ "${DEPLOY_LIB_ONLY:-0}" == "1" ]]; then return 0 2>/dev/null || exit 0; fi

if [[ "${LIST_SITES:-0}" -eq 1 ]]; then
  list_sites
  exit 0
fi

check_neighbour
install_node
install_files
write_env
install_service
if [[ -n "$ATTACH_SITE" || $DETACH_SITE -eq 1 ]]; then
  attach_to_site
else
  install_nginx
fi
health_check
print_nginx_snippet

echo
log "Готово"
echo "  Локально:  http://127.0.0.1:${PORT}${BASE_PATH}"
[[ -n "$DOMAIN" ]] && echo "  Домен:     http$([[ $WITH_SSL -eq 1 ]] && echo s)://${DOMAIN}${BASE_PATH}"
echo "  Логин:     ${AUTH_USER}"
if [[ "${GENERATED_PASSWORD:-0}" -eq 1 ]]; then
  echo "  Пароль:    ${AUTH_PASSWORD}   <- сгенерирован, сохраните"
else
  echo "  Пароль:    из ${DIR}/.env"
fi
if [[ "${TOKEN_FROM_PANEL:-0}" -eq 1 && ! -s "${DIR}/config/settings.json" ]]; then
  echo
  echo "  Токен Яндекс Доставки ещё не задан:"
  echo "  откройте панель → ⚙ Настройки → «Токен API» → Сохранить."
  echo
fi
echo "  Конфиг:    ${DIR}/.env"
echo "  Журнал:    journalctl -u ${SERVICE} -f"
echo "  Рестарт:   systemctl restart ${SERVICE}"
