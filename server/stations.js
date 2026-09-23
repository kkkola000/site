import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './config.js';
import { listWarehouses, listPickupPoints, retrieveWarehouse } from './yandex.js';

// Справочник точек: platform_id → { name, address }.
//
// Источники, в порядке приоритета:
//   1. config/stations.json — ручные соответствия;
//   2. warehouses/list — склады отгрузки;
//   3. pickup-points/list — пункты выдачи, одним запросом на все неизвестные id;
//   4. warehouses/retrieve — точечный запрос, если точка не нашлась в списках.
//
// Без справочника в карточке остаётся голый идентификатор ПВЗ, поэтому
// пункты 3 и 4 дозапрашиваются по мере появления новых заказов.

const OVERRIDES_PATH = resolve(ROOT, 'config/stations.json');
const TTL_MS = 60 * 60 * 1000;
// Адреса точек меняются редко, а вот повторять неудачный поиск каждую минуту незачем.
const POINT_TTL_MS = 6 * 60 * 60 * 1000;
const MISS_TTL_MS = 10 * 60 * 1000;
// Предохранитель: за один заход не больше стольких точечных запросов.
const RETRIEVE_LIMIT = 20;

let cache = { at: 0, map: new Map() };
let points = new Map(); // id → { at, value: { name, address } | null }

const clean = (value) => (typeof value === 'string' ? value.trim() : '');

function readOverrides() {
  if (!existsSync(OVERRIDES_PATH)) return [];
  try {
    const raw = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8'));
    const entries = Array.isArray(raw) ? raw : Object.entries(raw).map(([id, v]) => ({ id, ...(typeof v === 'string' ? { address: v } : v) }));
    return entries
      .map((entry) => ({
        id: String(entry.id || entry.platform_id || entry.platform_station_id || '').trim(),
        name: String(entry.name || '').trim(),
        address: String(entry.address || entry.full_address || '').trim(),
      }))
      .filter((entry) => entry.id);
  } catch (err) {
    console.error('[stations] config/stations.json не разобран:', err.message);
    return [];
  }
}

// Адрес точки: либо готовая строка, либо собранный из частей (город, улица, дом).
function joinAddress(address) {
  if (typeof address === 'string') return clean(address);
  if (!address || typeof address !== 'object') return '';
  if (clean(address.full_address)) return clean(address.full_address);

  const house = [clean(address.house), address.building ? `стр. ${clean(address.building)}` : '']
    .filter(Boolean)
    .join(', ');
  return [clean(address.city) || clean(address.locality), clean(address.street), house]
    .filter(Boolean)
    .join(', ');
}

// Точка из ответа API: у складов, ПВЗ и постаматов поля названы по-разному.
function extractPoint(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const id = String(
    entry.platform_station_id || entry.platform_id || entry.station_id || entry.pickup_point_id || entry.id || '',
  ).trim();
  if (!id) return null;

  const address =
    joinAddress(entry.address) ||
    joinAddress(entry.location?.address) ||
    joinAddress(entry.address?.details) ||
    joinAddress(entry.location?.details) ||
    joinAddress(entry.details) ||
    clean(entry.full_address);

  return { id, name: clean(entry.name) || clean(entry.title), address };
}

function extractList(payload) {
  const candidates = Array.isArray(payload)
    ? payload
    : payload?.points || payload?.pickup_points || payload?.warehouses || payload?.stations || payload?.items || payload?.list || [];
  if (!Array.isArray(candidates)) return [];
  return candidates.map(extractPoint).filter(Boolean);
}

export function resetStations() {
  cache = { at: 0, map: new Map() };
  points = new Map();
}

export async function getStations({ force = false } = {}) {
  const fresh = Date.now() - cache.at < TTL_MS;
  if (!force && fresh && cache.map.size) return cache.map;

  const map = new Map();
  try {
    for (const station of extractList(await listWarehouses())) {
      map.set(station.id, { name: station.name, address: station.address });
    }
  } catch (err) {
    // Справочник — необязательное обогащение: без него показываем platform_id.
    console.error('[stations] warehouses/list недоступен:', err.message);
  }

  for (const station of readOverrides()) {
    const current = map.get(station.id) || {};
    map.set(station.id, {
      name: station.name || current.name || '',
      address: station.address || current.address || '',
    });
  }

  cache = { at: Date.now(), map };
  return map;
}

function cached(id) {
  const entry = points.get(id);
  if (!entry) return undefined;
  const ttl = entry.value ? POINT_TTL_MS : MISS_TTL_MS;
  if (Date.now() - entry.at > ttl) {
    points.delete(id);
    return undefined;
  }
  return entry.value;
}

// Пункты выдачи одним запросом: фильтр pickup_points_ids.
// Если API фильтр не применит и вернёт весь список, лишнее отбрасываем сами.
async function fetchPickupPoints(ids) {
  const wanted = new Set(ids);
  const found = new Map();
  try {
    for (const point of extractList(await listPickupPoints({ pickup_points_ids: ids }))) {
      if (!wanted.has(point.id)) continue;
      if (point.name || point.address) found.set(point.id, { name: point.name, address: point.address });
    }
  } catch (err) {
    console.error('[stations] pickup-points/list недоступен:', err.message);
  }
  return found;
}

// Точечный запрос: сюда попадают точки, которых нет ни в складах, ни в ПВЗ.
async function fetchStation(id) {
  try {
    const payload = await retrieveWarehouse(id);
    const point = extractPoint(payload?.warehouse || payload);
    if (point && (point.name || point.address)) return { name: point.name, address: point.address };
  } catch (err) {
    console.error(`[stations] warehouses/retrieve ${id}:`, err.message);
  }
  return null;
}

/**
 * Справочник для конкретных точек: берёт готовые записи и дозапрашивает
 * недостающие. Точка считается известной, когда у неё есть адрес или название.
 */
export async function resolveStations(ids, { force = false } = {}) {
  const map = new Map(await getStations({ force }));
  const known = (id) => {
    const entry = map.get(id);
    return Boolean(entry && (entry.address || entry.name));
  };

  const wanted = [...new Set((ids || []).map((id) => clean(id)).filter(Boolean))];
  let unknown = [];
  for (const id of wanted) {
    if (known(id)) continue;
    const point = cached(id);
    if (point) map.set(id, point);
    else if (point === undefined) unknown.push(id);
  }
  if (!unknown.length) return map;

  const asked = unknown.length;
  const found = await fetchPickupPoints(unknown);
  for (const [id, point] of found) {
    points.set(id, { at: Date.now(), value: point });
    map.set(id, point);
  }

  let retrieved = 0;
  unknown = unknown.filter((id) => !found.has(id));
  for (const id of unknown.slice(0, RETRIEVE_LIMIT)) {
    const point = await fetchStation(id);
    points.set(id, { at: Date.now(), value: point });
    if (point) {
      map.set(id, point);
      retrieved += 1;
    }
  }

  // Одна строка в журнале на заход: по ней видно, нашлись ли адреса точек.
  console.log(
    `[stations] точек без адреса: ${asked}, нашлось: ${found.size} (pickup-points/list) + ${retrieved} (warehouses/retrieve)`,
  );
  return map;
}
