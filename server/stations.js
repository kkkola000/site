import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './config.js';
import { listWarehouses } from './yandex.js';

// Справочник складов/ПВЗ: platform_id → { name, address }.
// Источники: warehouses/list из API и локальный файл config/stations.json
// (ручные соответствия имеют приоритет — ими закрываются ПВЗ, которых нет в списке складов).

const OVERRIDES_PATH = resolve(ROOT, 'config/stations.json');
const TTL_MS = 60 * 60 * 1000;

let cache = { at: 0, map: new Map() };

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

// Ответ warehouses/list разбираем терпимо: имена полей у складов и ПВЗ различаются.
function extractStations(payload) {
  const candidates = Array.isArray(payload)
    ? payload
    : payload?.warehouses || payload?.stations || payload?.items || payload?.list || [];
  if (!Array.isArray(candidates)) return [];

  return candidates
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const id = String(
        entry.platform_station_id || entry.platform_id || entry.station_id || entry.id || '',
      ).trim();
      if (!id) return null;
      const details = entry.address?.details || entry.location?.details || entry.details || {};
      const address = String(
        (typeof entry.address === 'string' ? entry.address : '') ||
          entry.full_address ||
          details.full_address ||
          '',
      ).trim();
      return { id, name: String(entry.name || entry.title || '').trim(), address };
    })
    .filter(Boolean);
}

export async function getStations({ force = false } = {}) {
  const fresh = Date.now() - cache.at < TTL_MS;
  if (!force && fresh && cache.map.size) return cache.map;

  const map = new Map();
  try {
    for (const station of extractStations(await listWarehouses())) {
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
