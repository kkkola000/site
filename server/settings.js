import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ROOT, config } from './config.js';

// Настройки, которые задаются прямо в панели, а не в .env: токен API и склады.
// Файл лежит в config/ — единственном каталоге, куда служба может писать
// (см. ReadWritePaths в systemd-юните), и хранится с правами 600.

const FILE = process.env.SETTINGS_FILE || resolve(ROOT, 'config/settings.json');

let cache = null;

function load() {
  if (cache) return cache;
  cache = { token: '', stationIds: [], updatedAt: '' };
  if (existsSync(FILE)) {
    try {
      const raw = JSON.parse(readFileSync(FILE, 'utf8'));
      cache = {
        token: String(raw.token || '').trim(),
        stationIds: Array.isArray(raw.stationIds) ? raw.stationIds.filter(Boolean).map(String) : [],
        updatedAt: String(raw.updatedAt || ''),
      };
    } catch (err) {
      console.error('[settings] config/settings.json не разобран:', err.message);
    }
  }
  return cache;
}

export function saveSettings({ token, stationIds } = {}) {
  const current = load();
  const next = {
    // Пустая строка — осознанная очистка, undefined — поле не передавали.
    token: token === undefined ? current.token : String(token).trim(),
    stationIds:
      stationIds === undefined
        ? current.stationIds
        : (Array.isArray(stationIds) ? stationIds : String(stationIds).split(','))
            .map((id) => String(id).trim())
            .filter(Boolean),
    updatedAt: new Date().toISOString(),
  };

  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  // Права выставляем и при перезаписи существующего файла: writeFileSync
  // применяет mode только при создании.
  chmodSync(FILE, 0o600);

  cache = next;
  return next;
}

/** Токен: сначала введённый в панели, иначе из .env. */
export function effectiveToken() {
  return load().token || config.yandex.token;
}

export function effectiveStationIds() {
  const own = load().stationIds;
  return own.length ? own : config.yandex.stationIds;
}

export function tokenSource() {
  if (load().token) return 'panel';
  if (config.yandex.token) return 'env';
  return 'none';
}

/** В браузер полный токен не отдаём — только хвост, чтобы было видно, какой стоит. */
export function maskToken(token) {
  const value = String(token || '');
  if (!value) return '';
  if (value.length <= 8) return '•'.repeat(value.length);
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function settingsView() {
  const settings = load();
  const token = effectiveToken();
  return {
    tokenSet: Boolean(token),
    tokenMask: maskToken(token),
    tokenSource: tokenSource(),
    stationIds: effectiveStationIds(),
    updatedAt: settings.updatedAt,
    apiBase: config.yandex.base,
  };
}

// Нужно тестам: сбросить закэшированное состояние после подмены файла.
export function reloadSettings() {
  cache = null;
  return load();
}
