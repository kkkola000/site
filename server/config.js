import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Минимальный .env-парсер: без зависимостей, значения из окружения приоритетнее файла.
function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(process.env.ENV_FILE || resolve(ROOT, '.env'));

const num = (key, fallback) => {
  const value = Number(process.env[key]);
  return Number.isFinite(value) ? value : fallback;
};

const list = (key) =>
  (process.env[key] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const token = (process.env.YANDEX_OAUTH_TOKEN || '').trim();

// Панель может жить под подпутём существующего домена (например /orders).
// Нормализуем: '' либо '/orders' (без завершающего слэша).
const basePath = (process.env.BASE_PATH || '')
  .trim()
  .replace(/\/+$/, '')
  .replace(/^(?!\/)(.+)/, '/$1');

export const config = {
  port: num('PORT', 3000),
  basePath,
  host: process.env.HOST || '0.0.0.0',
  auth: {
    user: (process.env.AUTH_USER || '').trim(),
    password: (process.env.AUTH_PASSWORD || '').trim(),
  },
  yandex: {
    // Боевой контур Яндекс Доставки.
    base: (process.env.YANDEX_API_BASE || 'https://b2b-authproxy.taxi.yandex.net').replace(/\/+$/, ''),
    token,
    stationIds: list('YANDEX_STATION_IDS'),
    timeoutMs: num('REQUEST_TIMEOUT_MS', 15000),
  },
  lookbackDays: num('ORDERS_LOOKBACK_DAYS', 60),
  limit: num('ORDERS_LIMIT', 500),
  cacheTtlMs: num('CACHE_TTL_SECONDS', 60) * 1000,
  priceDivisor: num('PRICE_DIVISOR', 100),
  currency: process.env.CURRENCY || 'RUB',
};

export function authEnabled() {
  return Boolean(config.auth.user && config.auth.password);
}
