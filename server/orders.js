import { config } from './config.js';
import { listRequests, getRequestInfo, getRequestHistory, getActualInfo, explain } from './yandex.js';
import { getStations } from './stations.js';
import { normalizeOrder, searchIndex } from './normalize.js';
import { effectiveStationIds } from './settings.js';
import { TABS, resolveStatus } from './statuses.js';

let cache = { at: 0, orders: [], error: null };
let inflight = null;

function interval() {
  const to = new Date();
  const from = new Date(to.getTime() - config.lookbackDays * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

async function load() {
  const { from, to } = interval();
  const [stations, reports] = await Promise.all([
    getStations().catch(() => new Map()),
    listRequests({ from, to }),
  ]);

  let orders = reports
    .map((report) => normalizeOrder(report, { stations }))
    .filter((order) => order && order.id);

  // Фильтр по складам отгрузки, если он задан в настройках или в .env.
  const stationIds = effectiveStationIds();
  if (stationIds.length) {
    const allowed = new Set(stationIds);
    orders = orders.filter((order) => !order.shipment.stationId || allowed.has(order.shipment.stationId));
  }

  // Свежие заказы сверху.
  orders.sort((a, b) => String(b.groupDate || '').localeCompare(String(a.groupDate || '')));
  return orders.slice(0, config.limit);
}

export async function getOrders({ force = false } = {}) {
  const fresh = Date.now() - cache.at < config.cacheTtlMs;
  if (!force && fresh && cache.orders.length) return cache;

  // Параллельные запросы разделяют один поход в API.
  if (!inflight) {
    inflight = load()
      .then((orders) => {
        cache = { at: Date.now(), orders, error: null };
        return cache;
      })
      .catch((err) => {
        // Держим последний удачный снимок, но сообщаем об ошибке в UI.
        console.error('[orders]', explain(err));
        cache = { at: Date.now(), orders: cache.orders, error: explain(err) };
        return cache;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** Сбрасывает снимок заказов: вызывается после смены токена или складов. */
export function resetCache() {
  cache = { at: 0, orders: [], error: null };
  inflight = null;
}

export function filterOrders(orders, { tab = 'all', q = '' } = {}) {
  let result = orders;
  if (tab && tab !== 'all') {
    result = result.filter((order) => order.status.group === tab);
  }

  const query = q.trim().toLowerCase();
  if (query) {
    // Все слова запроса должны встретиться в индексе заказа.
    const words = query.split(/\s+/).filter(Boolean);
    result = result.filter((order) => {
      const index = order._index || (order._index = searchIndex(order));
      return words.every((word) => index.includes(word));
    });
  }
  return result;
}

export function countByTab(orders, { q = '' } = {}) {
  const base = filterOrders(orders, { tab: 'all', q });
  const counts = Object.fromEntries(TABS.map((tab) => [tab.id, 0]));
  counts.all = base.length;
  for (const order of base) {
    if (counts[order.status.group] !== undefined) counts[order.status.group] += 1;
  }
  return counts;
}

// Группировка по дате — как в списке заказов маркетплейса: «17 сентября», «16 сентября», …
export function groupByDate(orders) {
  const groups = new Map();
  for (const order of orders) {
    const key = (order.groupDate || '').slice(0, 10) || 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(order);
  }
  return [...groups.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, items]) => ({ date, orders: items }));
}

export function stripInternal(order) {
  const { _index, ...rest } = order;
  return rest;
}

/** Карточка заказа с историей статусов и актуальной датой доставки. */
export async function getOrderDetails(requestId) {
  const stations = await getStations().catch(() => new Map());
  const report = await getRequestInfo({ requestId });
  const order = normalizeOrder(report, { stations });
  if (!order) return null;

  const [history, actual] = await Promise.all([
    getRequestHistory(requestId).catch(() => null),
    // actual_info не отдаёт данные для доставленных/отменённых заказов — это не ошибка.
    getActualInfo(requestId).catch(() => null),
  ]);

  order.history = (history?.state_history || [])
    .map((state) => {
      const resolved = resolveStatus(state.status, state.description);
      return {
        code: resolved.code,
        label: resolved.label,
        description: state.description || '',
        group: resolved.group,
        at: state.timestamp_utc || (state.timestamp ? new Date(state.timestamp * 1000).toISOString() : ''),
        reason: state.reason || '',
      };
    })
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));

  if (actual) {
    order.actual = {
      deliveryDate: actual.delivery_date || '',
      interval: actual.delivery_interval || null,
      storageExpiresAt: actual.destination_storage_expiration_date || '',
    };
  }
  return order;
}
