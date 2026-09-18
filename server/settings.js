import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ROOT, config } from './config.js';

// Настройки, которые задаются прямо в панели, а не в .env: токен API и склады.
// Файл лежит в config/ — единственном каталоге, куда служба может писать
// (см. ReadWritePaths в systemd-юните), и хранится с правами 600.

const FILE = process.env.SETTINGS_FILE || resolve(ROOT, 'config/settings.json');

// Размеры ярлыка, которые принимает метод generate-labels.
export const LABEL_SIZES = [
  { value: '58x40', title: '58 × 40 мм (термопринтер)' },
  { value: '58x60', title: '58 × 60 мм' },
  { value: '75x120', title: '75 × 120 мм' },
  { value: '100x150', title: '100 × 150 мм' },
  { value: '210x297', title: 'A4 (210 × 297 мм)' },
];

export const DEFAULT_LABEL_SIZE = '58x40';

// Раскладка ярлыков на странице: one — один на страницу, many — максимум.
// Для A4 этим задаётся, сколько этикеток ляжет на лист.
export const LABEL_LAYOUTS = [
  { value: 'many', title: 'Максимум ярлыков на странице' },
  { value: 'one', title: 'Один ярлык на страницу' },
];

export const DEFAULT_LABEL_LAYOUT = 'many';

export function isLabelLayout(value) {
  return LABEL_LAYOUTS.some((layout) => layout.value === value);
}

export function isLabelSize(value) {
  return LABEL_SIZES.some((size) => size.value === value);
}

let cache = null;

function load() {
  if (cache) return cache;
  cache = {
    token: '',
    stationIds: [],
    labelSize: DEFAULT_LABEL_SIZE,
    labelLayout: DEFAULT_LABEL_LAYOUT,
    updatedAt: '',
  };
  if (existsSync(FILE)) {
    try {
      const raw = JSON.parse(readFileSync(FILE, 'utf8'));
      cache = {
        token: String(raw.token || '').trim(),
        stationIds: Array.isArray(raw.stationIds) ? raw.stationIds.filter(Boolean).map(String) : [],
        labelSize: isLabelSize(raw.labelSize) ? raw.labelSize : DEFAULT_LABEL_SIZE,
        labelLayout: isLabelLayout(raw.labelLayout) ? raw.labelLayout : DEFAULT_LABEL_LAYOUT,
        updatedAt: String(raw.updatedAt || ''),
      };
    } catch (err) {
      console.error('[settings] config/settings.json не разобран:', err.message);
    }
  }
  return cache;
}

export function saveSettings({ token, stationIds, labelSize, labelLayout } = {}) {
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
    // Неизвестный размер игнорируем: API примет только значения из списка.
    labelSize: isLabelSize(labelSize) ? labelSize : current.labelSize,
    labelLayout: isLabelLayout(labelLayout) ? labelLayout : current.labelLayout,
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

export function effectiveLabelSize() {
  const value = load().labelSize;
  return isLabelSize(value) ? value : DEFAULT_LABEL_SIZE;
}

export function effectiveLabelLayout() {
  const value = load().labelLayout;
  return isLabelLayout(value) ? value : DEFAULT_LABEL_LAYOUT;
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
    labelSize: effectiveLabelSize(),
    labelSizes: LABEL_SIZES,
    labelLayout: effectiveLabelLayout(),
    labelLayouts: LABEL_LAYOUTS,
    updatedAt: settings.updatedAt,
    apiBase: config.yandex.base,
  };
}

// Нужно тестам: сбросить закэшированное состояние после подмены файла.
export function reloadSettings() {
  cache = null;
  return load();
}
