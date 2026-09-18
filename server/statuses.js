// Статусная модель «Доставки в другой день» и её раскладка по разделам панели.
// Источник: yandex.ru/support/delivery-profile/ru/api/other-day/status-model
//
// Разделы: awaiting (Ожидает отгрузки), transit (В пути), ready (Готов к
// вручению), return (Возврат), done (Завершены). Граница между awaiting и
// transit — момент, когда заказ физически принят в сортировочном центре
// (SORTING_CENTER_AT_START); заказ, доехавший до точки выдачи и ожидающий
// получателя, выделен в отдельный раздел «Готов к вручению».
//
// major — основные статусы логистической цепочки (в документации выделены
// жирным), остальные считаются статусами детализации.

export const TABS = [
  { id: 'all', title: 'Все' },
  { id: 'awaiting', title: 'Ожидает отгрузки' },
  { id: 'transit', title: 'В пути' },
  { id: 'ready', title: 'Готов к вручению' },
  { id: 'return', title: 'Возврат' },
  { id: 'done', title: 'Завершены' },
];

export const TAB_IDS = TABS.map((t) => t.id);

const STATUS_MAP = {
  // --- До передачи в сортировочный центр ---
  VALIDATING_ERROR: { group: 'awaiting', label: 'Не подтверждён в СЦ', problem: true },
  CREATED: { group: 'awaiting', label: 'Создан', major: true },
  DELIVERY_PROCESSING_STARTED: { group: 'awaiting', label: 'Оформляется в СЦ' },
  SORTING_CENTER_LOADED: { group: 'awaiting', label: 'Подтверждён в СЦ' },

  // --- В пути ---
  SORTING_CENTER_AT_START: { group: 'transit', label: 'Принят в СЦ', major: true },
  SORTING_CENTER_PREPARED: { group: 'transit', label: 'Готов к отправке' },
  SORTING_CENTER_TRANSMITTED: { group: 'transit', label: 'Передан в доставку' },
  DELIVERY_AT_START: { group: 'transit', label: 'В городе получателя' },
  DELIVERY_AT_START_SORT: { group: 'transit', label: 'В городе получателя' },
  DELIVERY_TRANSPORTATION: { group: 'transit', label: 'Едет в пункт выдачи' },
  DELIVERY_TRANSPORTATION_RECIPIENT: { group: 'transit', label: 'Доставляется клиенту' },
  DELIVERY_TIME_INTERVALS_UPDATED: { group: 'transit', label: 'Время доставки изменено' },
  DELIVERY_ATTEMPT_FAILED: { group: 'transit', label: 'Не вручён', problem: true },

  // --- Готов к вручению: заказ на месте и ждёт получателя ---
  DELIVERY_ARRIVED_PICKUP_POINT: { group: 'ready', label: 'Готов к вручению', major: true },
  CONFIRMATION_CODE_RECEIVED: { group: 'ready', label: 'Готов к вручению' },
  PARTICULARLY_DELIVERED: { group: 'ready', label: 'Готов к вручению', major: true },

  // --- Завершены ---
  DELIVERY_TRANSMITTED_TO_RECIPIENT: { group: 'done', label: 'Выдан получателю' },
  DELIVERY_DELIVERED: { group: 'done', label: 'Доставлен', major: true },
  CANCELLED: { group: 'done', label: 'Отменён', major: true },
  // Возврат доехал до магазина — работа по заказу закончена.
  RETURN_RETURNED: { group: 'done', label: 'Возвращён в магазин', major: true },

  // --- Возврат ---
  SORTING_CENTER_RETURN_RETURNED: { group: 'return', label: 'Возвращён отправителю' },
  RETURN_TRANSPORTATION_STARTED: { group: 'return', label: 'Едет в точку выдачи', major: true },
  RETURN_ARRIVED_DELIVERY: { group: 'return', label: 'Возвращён на склад', major: true },
  RETURN_READY_FOR_PICKUP: { group: 'return', label: 'Готов к передаче магазину', major: true },
};

// Запасная раскладка для статусов, которых ещё нет в этом каталоге:
// порядок важен, более специфичные шаблоны идут раньше.
const PATTERNS = [
  [/RETURN/, { group: 'return', label: 'Возврат' }],
  [/(ARRIVED_PICKUP|READY_FOR_HANDOVER|CONFIRMATION_CODE)/, { group: 'ready', label: 'Готов к вручению' }],
  [/(DELIVERED|TRANSMITTED_TO_RECIPIENT)/, { group: 'done', label: 'Доставлен' }],
  [/CANCEL/, { group: 'done', label: 'Отменён' }],
  [/(DELIVERY|SORTING_CENTER|TRANSPORT|COURIER|PICKUP)/, { group: 'transit', label: 'В пути' }],
  [/(CREATE|VALIDAT|NEW|PROCESSING)/, { group: 'awaiting', label: 'Ожидает отгрузки' }],
];

// Статусы, которые панель подсвечивает как требующие внимания.
const PROBLEM = /(ERROR|FAILED|LOST|DAMAGED|EXPIRED)/;

export function normalizeStatusCode(status) {
  if (!status) return '';
  return String(status).trim().toUpperCase().replace(/[\s-]+/g, '_');
}

export function resolveStatus(status, description) {
  const code = normalizeStatusCode(status);
  const known = STATUS_MAP[code];

  if (known) {
    return {
      code,
      group: known.group,
      label: known.label,
      description: description || '',
      major: Boolean(known.major),
      problem: Boolean(known.problem) || PROBLEM.test(code),
    };
  }

  const problem = PROBLEM.test(code);
  for (const [pattern, fallback] of PATTERNS) {
    if (pattern.test(code)) {
      return { code, group: fallback.group, label: fallback.label, description: description || '', major: false, problem };
    }
  }
  return {
    code,
    group: 'awaiting',
    label: description || code || 'Без статуса',
    description: description || '',
    major: false,
    problem,
  };
}

export function isKnownTab(tab) {
  return TAB_IDS.includes(tab);
}
