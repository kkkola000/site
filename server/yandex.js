import { config } from './config.js';
import { effectiveToken, DEFAULT_LABEL_SIZE, DEFAULT_LABEL_LAYOUT } from './settings.js';

// Эндпоинты API «Доставка в другой день» (b2b-authproxy.taxi.yandex.net).
// Источник: Список методов, раздел «3. Основные запросы».
export const ENDPOINTS = {
  requestsInfo: { method: 'POST', path: '/api/b2b/platform/requests/info' },      // заявки за интервал
  requestInfo: { method: 'GET', path: '/api/b2b/platform/request/info' },         // заявка по id
  requestHistory: { method: 'GET', path: '/api/b2b/platform/request/history' },   // история статусов
  requestActualInfo: { method: 'GET', path: '/api/b2b/platform/request/actual_info' },
  requestCancel: { method: 'POST', path: '/api/b2b/platform/request/cancel' },
  generateLabels: { method: 'POST', path: '/api/b2b/platform/request/generate-labels' },
  warehousesList: { method: 'POST', path: '/api/b2b/platform/warehouses/list' },
  pickupPointsList: { method: 'POST', path: '/api/b2b/platform/pickup-points/list' },
};

export class YandexApiError extends Error {
  constructor(message, { status = 0, endpoint = '', body = null } = {}) {
    super(message);
    this.name = 'YandexApiError';
    this.status = status;
    this.endpoint = endpoint;
    this.body = body;
  }
}

function buildUrl(path, query) {
  const url = new URL(config.yandex.base + path);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

async function readBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function describeError(body, status) {
  if (body && typeof body === 'object') {
    return body.message || body.error || body.code || `HTTP ${status}`;
  }
  if (typeof body === 'string' && body.trim()) return body.slice(0, 300);
  return `HTTP ${status}`;
}

/**
 * Запрос к API. Возвращает распарсенный JSON либо Buffer для бинарных ответов (PDF ярлыков).
 * Повтор — только для сетевых ошибок и 5xx: 4xx повторять бессмысленно.
 */
export async function call(endpoint, { query, body, raw = false, retries = 2 } = {}) {
  const token = effectiveToken();
  if (!token) {
    throw new YandexApiError('Токен Яндекс Доставки не задан — укажите его в настройках панели', {
      endpoint: endpoint.path,
      status: 0,
    });
  }

  const url = buildUrl(endpoint.path, query);
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.yandex.timeoutMs);
    try {
      const response = await fetch(url, {
        method: endpoint.method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: raw ? 'application/pdf' : 'application/json',
          ...(endpoint.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        },
        body: endpoint.method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
        signal: controller.signal,
      });

      if (response.ok) {
        if (raw) {
          return {
            buffer: Buffer.from(await response.arrayBuffer()),
            contentType: response.headers.get('content-type') || 'application/octet-stream',
          };
        }
        return await readBody(response);
      }

      const errorBody = await readBody(response);
      const error = new YandexApiError(describeError(errorBody, response.status), {
        status: response.status,
        endpoint: endpoint.path,
        body: errorBody,
      });
      // 4xx — ответ сервера, повтор не поможет.
      if (response.status < 500) throw error;
      lastError = error;
    } catch (err) {
      if (err instanceof YandexApiError && err.status && err.status < 500) throw err;
      lastError =
        err instanceof YandexApiError
          ? err
          : new YandexApiError(
              err.name === 'AbortError' ? `Таймаут ${config.yandex.timeoutMs} мс` : err.message,
              { endpoint: endpoint.path },
            );
    } finally {
      clearTimeout(timer);
    }

    if (attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
    }
  }

  throw lastError;
}

/** Человекочитаемое объяснение ошибки API — одинаковое в логах, в баннере и в ответах. */
export function explain(err) {
  if (err instanceof YandexApiError) {
    if (err.status === 401 || err.status === 403) {
      return 'Яндекс Доставка отклонила токен (HTTP ' + err.status + '). Проверьте его в настройках панели.';
    }
    if (!err.status) return `Нет связи с API Яндекс Доставки: ${err.message}`;
    return `Яндекс Доставка (HTTP ${err.status}): ${err.message}`;
  }
  return err?.message || 'Внутренняя ошибка';
}

// ---- Методы ----

export const getRequestInfo = ({ requestId, requestCode }) =>
  call(ENDPOINTS.requestInfo, { query: { request_id: requestId, request_code: requestCode } });

export const getRequestHistory = (requestId) =>
  call(ENDPOINTS.requestHistory, { query: { request_id: requestId } });

export const getActualInfo = (requestId) =>
  call(ENDPOINTS.requestActualInfo, { query: { request_id: requestId } });

// Тело запроса — по документации метода 4.01: request_ids (массив),
// label_size_mm из перечня, language и generate_type.
//
// generate_type задаёт раскладку на листе A4, но отправляется всегда: без него
// размер этикетки всё равно не применялся, а API ожидает полное тело запроса.
export const A4_LABEL_SIZE = '210x297';

export const generateLabels = (
  requestIds,
  { labelSize = DEFAULT_LABEL_SIZE, generateType = DEFAULT_LABEL_LAYOUT, idsAsString = false } = {},
) => {
  const ids = Array.isArray(requestIds) ? requestIds : [requestIds];
  const body = {
    // Тип поля — массив строк, но пример в документации показывает одиночную
    // строку. Если размер игнорируется, панель повторяет запрос в этой форме.
    request_ids: idsAsString && ids.length === 1 ? ids[0] : ids,
    label_size_mm: labelSize,
    language: 'ru',
  };
  body.generate_type = generateType;

  return call(ENDPOINTS.generateLabels, { raw: true, body });
};

export const listWarehouses = () => call(ENDPOINTS.warehousesList, { body: {} });

/**
 * Список заявок, созданных в интервале: POST /api/b2b/platform/requests/info.
 * Тело: { from, to, request_ids } — from/to в UTC (ISO 8601 или UNIX timestamp),
 * request_ids — необязательный список конкретных заказов.
 * Ответ: { requests: RequestReport[] }.
 */
export async function listRequests({ from, to, requestIds } = {}) {
  const body = {};
  if (from) body.from = from;
  if (to) body.to = to;
  if (requestIds && requestIds.length) body.request_ids = requestIds;

  const data = await call(ENDPOINTS.requestsInfo, { body });
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.requests) ? data.requests : [];
}
