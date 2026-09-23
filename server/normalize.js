import { config } from './config.js';
import { resolveStatus } from './statuses.js';

const money = (kopecks) => {
  const value = Number(kopecks);
  if (!Number.isFinite(value)) return null;
  return value / config.priceDivisor;
};

const clean = (value) => (typeof value === 'string' ? value.trim() : '');

// Собирает читаемый адрес из LocationDetails, когда full_address не заполнен.
export function formatAddress(details) {
  if (!details || typeof details !== 'object') return '';
  if (clean(details.full_address)) return clean(details.full_address);

  const head = [details.locality || details.region, details.street, details.house]
    .map(clean)
    .filter(Boolean)
    .join(', ');
  const extra = [
    details.housing ? `к${clean(details.housing)}` : '',
    details.building ? `стр. ${clean(details.building)}` : '',
    details.room ? `кв. ${clean(details.room)}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  return [head, extra].filter(Boolean).join(', ');
}

// Дополнительные детали адреса: подъезд/этаж/домофон/комментарий.
function addressHints(details) {
  if (!details || typeof details !== 'object') return '';
  return [
    details.porch ? `подъезд ${clean(details.porch)}` : '',
    details.floor ? `этаж ${clean(details.floor)}` : '',
    details.intercom ? `домофон ${clean(details.intercom)}` : '',
    clean(details.comment),
  ]
    .filter(Boolean)
    .join(' · ');
}

const PAYMENT_METHODS = {
  already_paid: 'Оплачен',
  card_on_receipt: 'Картой при получении',
  postpay: 'Постоплата',
};

const CANCEL_REASONS = {
  SHOP_CANCELLED: 'Магазин отменил заказ',
  USER_CHANGED_MIND: 'Получатель передумал',
  DELIVERY_PROBLEMS: 'Проблемы при доставке',
  BROKEN_ITEM: 'Товар бракованный',
  ORDER_WAS_LOST: 'Заказ утерян',
  DIMENSIONS_EXCEEDED: 'Превышены габариты',
  ORDER_IS_DAMAGED: 'Заказ повреждён',
  EXTRA_RESCHEDULING: 'Частые переносы',
  PICKUP_EXPIRED: 'Истёк срок хранения в ПВЗ',
  LAST_MILE_CHANGED_BY_USER: 'Изменена точка назначения',
  CLIENT_REQUEST: 'Перенос по просьбе получателя',
  DELIVERY_DATE_UPDATED_BY_DELIVERY: 'Перенос по вине оператора',
  DELIVERY_DATE_UPDATED_BY_SHOP: 'Перенос по вине магазина',
};

// timestamp_utc — строка ISO, timestamp — UNIX-секунды. Возвращаем ISO либо ''.
function toIso(value) {
  if (!value) return '';
  if (typeof value === 'number') return new Date(value * 1000).toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

function normalizeInterval(interval) {
  if (!interval || typeof interval !== 'object') return null;
  const from = toIso(interval.from);
  const to = toIso(interval.to);
  if (!from && !to) return null;
  return { from, to };
}

/**
 * Тип невыкупа по документации: полный — получатель отказался от всех единиц
 * каждого товара, частичный — отказ есть, но забрали хотя бы часть.
 */
function refusalType(items) {
  if (!items.length || !items.some((item) => item.refusedCount > 0)) return 'none';
  const all = items.every((item) => item.count > 0 && item.refusedCount >= item.count);
  return all ? 'full' : 'partial';
}

/**
 * Приводит RequestReport (ответ requests/info и request/info) к карточке заказа панели.
 * stations — справочник platform_id → { name, address } для адресов складов и ПВЗ.
 */
export function normalizeOrder(report, { stations = new Map() } = {}) {
  if (!report || typeof report !== 'object') return null;

  const request = report.request || {};
  const state = report.state || {};
  const status = resolveStatus(state.status, clean(state.description));

  const items = (Array.isArray(request.items) ? request.items : [])
    .filter(Boolean)
    .map((item) => {
      const unitPrice = money(item?.billing_details?.unit_price);
      // Оценочная стоимость — сумма, на которую застрахован товар.
      const assessedPrice = money(item?.billing_details?.assessed_unit_price);
      const count = Number(item?.count) || 0;
      return {
        name: clean(item?.name) || 'Без названия',
        article: clean(item?.article),
        count,
        unitPrice,
        assessedPrice,
        total: unitPrice === null ? null : unitPrice * count,
        assessedTotal: assessedPrice === null ? null : assessedPrice * count,
        barcode: clean(item?.place_barcode),
        refusedCount: Number(item?.refused_count) || 0,
      };
    });

  // full_items_price — общая стоимость предметов; если её нет, считаем по позициям.
  const itemsSum = items.reduce((sum, item) => sum + (item.total || 0), 0);
  const totalPrice = money(report.full_items_price) ?? itemsSum;
  const insurance = items.reduce((sum, item) => sum + (item.assessedTotal || 0), 0);

  const station = (id) => (id ? stations.get(id) || null : null);

  const sourceId = clean(request?.source?.platform_station?.platform_id);
  const sourceStation = station(sourceId);
  const shipment = {
    stationId: sourceId,
    name: sourceStation?.name || '',
    address: sourceStation?.address || '',
    interval: normalizeInterval(request?.source?.interval_utc),
  };

  const destination = request?.destination || {};
  const destinationId = clean(destination?.platform_station?.platform_id);
  const destinationStation = station(destinationId);
  const details = destination?.custom_location?.details || null;
  const isPickup = destination?.type === 'platform_station';
  const delivery = {
    type: isPickup ? 'pickup_point' : 'courier',
    typeLabel: isPickup ? 'До пункта выдачи' : 'Курьером до двери',
    stationId: destinationId,
    name: destinationStation?.name || '',
    address: isPickup
      ? destinationStation?.address || (destinationId ? `ПВЗ ${destinationId}` : '')
      : formatAddress(details),
    hints: isPickup ? '' : addressHints(details),
    interval: normalizeInterval(destination?.interval_utc),
  };

  const recipient = request?.recipient_info || {};
  const recipientName = [recipient.last_name, recipient.first_name, recipient.patronymic]
    .map(clean)
    .filter(Boolean)
    .join(' ');

  const places = (Array.isArray(request.places) ? request.places : []).filter(Boolean).map((place) => ({
    barcode: clean(place?.barcode),
    weightGross: Number(place?.physical_dims?.weight_gross) || 0,
    dims: ['dx', 'dy', 'dz'].map((k) => Number(place?.physical_dims?.[k]) || 0),
  }));

  const statusAt = toIso(state.timestamp_utc || state.timestamp);
  // Дата для группировки списка: плановая доставка → отгрузка → время статуса.
  const groupDate = delivery.interval?.from || shipment.interval?.from || statusAt;

  return {
    id: clean(report.request_id),
    orderNumber: clean(request?.info?.operator_request_id) || clean(report.request_id),
    courierOrderId: clean(report.courier_order_id),
    // Трек-номер для получателя — номер в системе оператора; до его появления показываем ID заявки.
    trackNumber: clean(report.courier_order_id) || clean(report.request_id),
    merchantId: clean(request?.info?.merchant_id),
    comment: clean(request?.info?.comment),
    status: {
      code: status.code,
      group: status.group,
      stage: status.stage,
      label: status.label,
      description: status.description,
      problem: status.problem,
      reason: clean(state.reason),
      reasonLabel: CANCEL_REASONS[clean(state.reason)] || clean(state.reason),
      at: statusAt,
    },
    items,
    itemsCount: items.reduce((sum, item) => sum + item.count, 0),
    totalPrice,
    insurance,
    deliveryCost: money(request?.billing_info?.delivery_cost) ?? 0,
    paymentMethod: clean(request?.billing_info?.payment_method),
    paymentMethodLabel:
      PAYMENT_METHODS[clean(request?.billing_info?.payment_method)] ||
      clean(request?.billing_info?.payment_method),
    recipient: {
      name: recipientName,
      phone: clean(recipient.phone),
      email: clean(recipient.email),
    },
    shipment,
    delivery,
    places,
    lastMilePolicy: clean(request?.last_mile_policy),
    sharingUrl: clean(report.sharing_url),
    selfPickupCode: clean(report?.self_pickup_node_code?.code),
    hasReturnPlaces: Array.isArray(report.return_places) && report.return_places.length > 0,
    refusal: refusalType(items),
    availableActions: request?.available_actions || {},
    groupDate,
    currency: config.currency,
  };
}

// Строка для поиска по заказу: номер, трек, товары, артикулы, адреса, получатель.
export function searchIndex(order) {
  return [
    order.orderNumber,
    order.id,
    order.trackNumber,
    order.courierOrderId,
    order.comment,
    order.status.label,
    order.recipient.name,
    order.recipient.phone,
    order.shipment.name,
    order.shipment.address,
    order.delivery.name,
    order.delivery.address,
    ...order.items.flatMap((item) => [item.name, item.article, item.barcode]),
    ...order.places.map((place) => place.barcode),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}
