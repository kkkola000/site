// Каталог статусов Яндекс Доставки и их раскладка по разделам панели.
//
// Разделы панели: awaiting (Ожидает отгрузки), transit (В пути),
// return (Возврат), done (Завершены). Раздел «Все» — псевдо-раздел.
//
// В API «Доставка в другой день» статусы приходят в верхнем регистре
// (DELIVERED_FINISH), в экспресс-доставке — в нижнем (delivered_finish),
// поэтому ключи нормализуются к верхнему регистру. Неизвестные статусы
// раскладываются эвристикой matchByPattern(), чтобы новый статус в API
// не ронял фильтрацию.

export const TABS = [
  { id: 'all', title: 'Все' },
  { id: 'awaiting', title: 'Ожидает отгрузки' },
  { id: 'transit', title: 'В пути' },
  { id: 'return', title: 'Возврат' },
  { id: 'done', title: 'Завершены' },
];

export const TAB_IDS = TABS.map((t) => t.id);

const STATUS_MAP = {
  // --- Оформление заявки ---
  DRAFT: { group: 'awaiting', label: 'Черновик' },
  VALIDATING: { group: 'awaiting', label: 'Проверяется' },
  VALIDATING_ERROR: { group: 'awaiting', label: 'Ошибка проверки' },
  NEW: { group: 'awaiting', label: 'Новый' },
  ESTIMATING: { group: 'awaiting', label: 'Расчёт стоимости' },
  ESTIMATING_FAILED: { group: 'awaiting', label: 'Не удалось рассчитать' },
  READY_FOR_APPROVAL: { group: 'awaiting', label: 'Ожидает подтверждения' },
  CREATED: { group: 'awaiting', label: 'Ожидает отгрузки' },
  CREATED_ERROR: { group: 'awaiting', label: 'Ошибка создания' },
  ACCEPTED: { group: 'awaiting', label: 'Подтверждён' },
  PERFORMER_LOOKUP: { group: 'awaiting', label: 'Поиск курьера' },
  PERFORMER_DRAFT: { group: 'awaiting', label: 'Поиск курьера' },
  PERFORMER_FOUND: { group: 'awaiting', label: 'Курьер назначен' },
  PERFORMER_NOT_FOUND: { group: 'awaiting', label: 'Курьер не найден' },
  PICKUP_ARRIVED: { group: 'awaiting', label: 'Курьер на складе' },
  READY_FOR_PICKUP_CONFIRMATION: { group: 'awaiting', label: 'Подтверждение отгрузки' },

  // --- В пути (семейство DELIVERY_* в статусной модели НДД) ---
  DELIVERY_LOADED: { group: 'transit', label: 'Принят в доставку' },
  DELIVERY_AT_START: { group: 'transit', label: 'На складе отправления' },
  DELIVERY_TRANSPORTATION: { group: 'transit', label: 'В пути' },
  DELIVERY_ARRIVED_PICKUP: { group: 'transit', label: 'Ожидает в ПВЗ' },
  DELIVERY_DELIVERED: { group: 'done', label: 'Доставлен' },

  PICKUPED: { group: 'transit', label: 'Отгружен' },
  PICKED_UP: { group: 'transit', label: 'Отгружен' },
  TRANSPORTATION: { group: 'transit', label: 'В пути' },
  IN_TRANSIT: { group: 'transit', label: 'В пути' },
  DELIVERY: { group: 'transit', label: 'Доставляется' },
  DELIVERY_PENDING: { group: 'transit', label: 'Ожидает доставки' },
  DELIVERY_ARRIVED: { group: 'transit', label: 'Курьер у получателя' },
  DELIVERY_AT_POINT: { group: 'transit', label: 'Ожидает в ПВЗ' },
  ARRIVED_TO_PICKUP_POINT: { group: 'transit', label: 'Ожидает в ПВЗ' },
  READY_FOR_DELIVERY_CONFIRMATION: { group: 'transit', label: 'Подтверждение вручения' },
  PAY_WAITING: { group: 'transit', label: 'Ожидает оплаты' },

  // --- Возврат ---
  RETURNING: { group: 'return', label: 'Возвращается' },
  RETURN_ARRIVED: { group: 'return', label: 'Возврат прибыл' },
  READY_FOR_RETURN_CONFIRMATION: { group: 'return', label: 'Подтверждение возврата' },
  RETURNED: { group: 'return', label: 'Возвращён' },
  CANCELLED_WITH_ITEMS_ON_HANDS: { group: 'return', label: 'Отменён, товар у курьера' },

  // --- Завершены ---
  DELIVERED: { group: 'done', label: 'Доставлен' },
  DELIVERED_FINISH: { group: 'done', label: 'Доставлен' },
  RETURNED_FINISH: { group: 'done', label: 'Возврат завершён' },
  FINISHED: { group: 'done', label: 'Завершён' },
  CANCELLED: { group: 'done', label: 'Отменён' },
  CANCELLED_BY_TAXI: { group: 'done', label: 'Отменён службой' },
  CANCELLED_WITH_PAYMENT: { group: 'done', label: 'Отменён (платно)' },
  CANCEL_ERROR: { group: 'done', label: 'Ошибка отмены' },
  FAILED: { group: 'done', label: 'Ошибка' },
  ERROR: { group: 'awaiting', label: 'Ошибка' },
};

// Порядок важен: более специфичные шаблоны идут раньше.
// Статусы, которые подсвечиваются как проблемные (красный бейдж в панели).
const PROBLEM = /(ERROR|FAILED|NOT_FOUND|LOST|DAMAGED)/;

const PATTERNS = [
  [/RETURN/, { group: 'return', label: 'Возврат' }],
  [/(DELIVERED|FINISH|COMPLETE)/, { group: 'done', label: 'Завершён' }],
  [/CANCEL/, { group: 'done', label: 'Отменён' }],
  [/(DELIVER|TRANSPORT|TRANSIT|PICKUPED|PICKED_UP|COURIER)/, { group: 'transit', label: 'В пути' }],
  [/(DRAFT|VALID|CREATE|NEW|ESTIMAT|APPROV|ACCEPT|PERFORMER|PICKUP)/, { group: 'awaiting', label: 'Ожидает отгрузки' }],
];

export function normalizeStatusCode(status) {
  if (!status) return '';
  return String(status).trim().toUpperCase().replace(/[\s-]+/g, '_');
}

export function resolveStatus(status, description) {
  const code = normalizeStatusCode(status);
  const problem = PROBLEM.test(code);
  const known = STATUS_MAP[code];
  if (known) {
    return { code, group: known.group, label: known.label, description: description || '', problem };
  }

  for (const [pattern, fallback] of PATTERNS) {
    if (pattern.test(code)) {
      return { code, group: fallback.group, label: fallback.label, description: description || '', problem };
    }
  }
  return {
    code,
    group: 'awaiting',
    label: description || code || 'Без статуса',
    description: description || '',
    problem,
  };
}

export function isKnownTab(tab) {
  return TAB_IDS.includes(tab);
}
