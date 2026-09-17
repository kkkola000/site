#!/usr/bin/env bash
#
# Развёртывание одной командой:
#
#   curl -fsSL https://raw.githubusercontent.com/kkkola000/site/claude/nifty-sagan-m384gm/deploy/bootstrap.sh \
#     | sudo bash -s -- --allow-subnet 10.66.66.0/24
#
# Скрипт забирает код в /opt/anex-orders-src и запускает deploy/deploy.sh,
# передавая ему все аргументы. Повторный запуск обновляет код и панель.
#
set -euo pipefail

REPO=${REPO:-https://github.com/kkkola000/site}
BRANCH=${BRANCH:-claude/nifty-sagan-m384gm}
SRC=${SRC:-/opt/anex-orders-src}

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mОшибка:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "запустите через sudo"

if [[ "${SKIP_CLONE:-0}" != "1" ]]; then
  if ! command -v git >/dev/null; then
    log "Ставлю git"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq && apt-get install -y -qq git ca-certificates >/dev/null
  fi

  if [[ -d "$SRC/.git" ]]; then
    log "Обновляю код в $SRC"
    git -C "$SRC" fetch --quiet origin "$BRANCH"
    git -C "$SRC" checkout --quiet -B "$BRANCH" "origin/$BRANCH"
  else
    log "Забираю код в $SRC"
    rm -rf "$SRC"
    git clone --quiet --branch "$BRANCH" --depth 1 "$REPO" "$SRC"
  fi
fi

[[ -f "$SRC/deploy/deploy.sh" ]] || die "в $SRC нет deploy/deploy.sh"

log "Запускаю установку"
exec bash "$SRC/deploy/deploy.sh" "$@"
