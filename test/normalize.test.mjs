import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOrder, searchIndex, formatAddress } from '../server/normalize.js';
import { resolveStatus, TABS, STAGES } from '../server/statuses.js';
import { reportPickup, reportCourier } from './fixtures.mjs';

const stations = new Map([
  ['e1139f6d-e34f-47a9-a55f-31f032a861a6', { name: 'Склад ANEX', address: 'Москва, Ленинградский проспект, 27' }],
  ['01946f4f013c7337874ec2fb848a58a4', { name: 'ПВЗ', address: 'Москва, Ленинградский проспект, 37 к9' }],
]);

test('заказ до ПВЗ: цены из копеек, трек-номер и адреса из справочника', () => {
  const order = normalizeOrder(reportPickup, { stations });
  assert.equal(order.orderNumber, 'lKF4565ml');
  assert.equal(order.trackNumber, '786459112');
  assert.equal(order.totalPrice, 23000);
  assert.equal(order.items[0].unitPrice, 23000);
  assert.equal(order.itemsCount, 1);
  assert.equal(order.status.group, 'transit');
  assert.equal(order.shipment.address, 'Москва, Ленинградский проспект, 27');
  assert.equal(order.delivery.type, 'pickup_point');
  assert.equal(order.delivery.address, 'Москва, Ленинградский проспект, 37 к9');
  // Группировка идёт по плановой дате доставки.
  assert.equal(order.groupDate.slice(0, 10), '2026-09-17');
});

test('курьерский заказ: адрес собирается из деталей, возврат попадает в свой раздел', () => {
  const order = normalizeOrder(reportCourier, { stations });
  assert.equal(order.delivery.type, 'courier');
  assert.equal(order.delivery.address, 'Реутов, Юбилейный проспект, 12, к1');
  assert.match(order.delivery.hints, /подъезд 3/);
  assert.equal(order.status.group, 'return');
  assert.equal(order.status.label, 'Едет в точку выдачи');
  assert.equal(order.status.reasonLabel, 'Получатель передумал');
  assert.equal(order.totalPrice, 240000);
  assert.equal(order.deliveryCost, 500);
  // Получатель отказался от 1 из 2 единиц — это частичный невыкуп.
  assert.equal(order.refusal, 'partial');
  assert.equal(order.hasReturnPlaces, true);
  // Пока оператор не присвоил номер, показываем ID заявки.
  assert.equal(order.trackNumber, 'aa11bb22cc33-udp');
});

test('поисковый индекс покрывает номер, товар, артикул и адрес', () => {
  const index = searchIndex(normalizeOrder(reportPickup, { stations }));
  for (const needle of ['lkf4565ml', '786459112', 'сумка anex', 'ac/cb-02', 'ленинградский']) {
    assert.ok(index.includes(needle), `не найдено: ${needle}`);
  }
});

test('вся статусная модель раскладывается по разделам панели', () => {
  const groups = TABS.map((tab) => tab.id);
  // Полный список статусов из документации «Доставки в другой день»
  // (обе ветки — до двери и до ПВЗ).
  const cases = {
    VALIDATING_ERROR: 'awaiting',
    CREATED: 'awaiting',
    DELIVERY_PROCESSING_STARTED: 'awaiting',
    SORTING_CENTER_LOADED: 'awaiting',

    SORTING_CENTER_AT_START: 'transit',
    SORTING_CENTER_PREPARED: 'transit',
    SORTING_CENTER_TRANSMITTED: 'transit',
    DELIVERY_AT_START: 'transit',
    DELIVERY_AT_START_SORT: 'transit',
    DELIVERY_TRANSPORTATION: 'transit',
    DELIVERY_TRANSPORTATION_RECIPIENT: 'transit',
    DELIVERY_TIME_INTERVALS_UPDATED: 'transit',
    DELIVERY_ATTEMPT_FAILED: 'transit',

    DELIVERY_ARRIVED_PICKUP_POINT: 'ready',
    CONFIRMATION_CODE_RECEIVED: 'ready',
    PARTICULARLY_DELIVERED: 'ready',

    DELIVERY_TRANSMITTED_TO_RECIPIENT: 'done',
    DELIVERY_DELIVERED: 'done',
    CANCELLED: 'done',

    SORTING_CENTER_RETURN_RETURNED: 'return',
    RETURN_TRANSPORTATION_STARTED: 'return',
    RETURN_ARRIVED_DELIVERY: 'return',
    RETURN_READY_FOR_PICKUP: 'return',
    // Возврат доехал до магазина — заказ закрыт.
    RETURN_RETURNED: 'done',
  };

  for (const [status, expected] of Object.entries(cases)) {
    const resolved = resolveStatus(status, '');
    assert.equal(resolved.group, expected, `${status} → ${resolved.group}`);
    assert.ok(groups.includes(resolved.group));
    // У каждого известного статуса есть человекочитаемое название, не код.
    assert.ok(resolved.label && resolved.label !== status, `${status}: нет названия`);
  }
});

test('три статуса на точке выдачи показываются одним понятным статусом', () => {
  // На складе и в ПВЗ важно одно: заказ на месте и ждёт получателя.
  for (const status of ['DELIVERY_ARRIVED_PICKUP_POINT', 'CONFIRMATION_CODE_RECEIVED', 'PARTICULARLY_DELIVERED']) {
    const resolved = resolveStatus(status, '');
    assert.equal(resolved.group, 'ready', status);
    assert.equal(resolved.label, 'Готов к вручению', status);
  }
  assert.ok(TABS.some((tab) => tab.id === 'ready' && tab.title === 'Готов к вручению'));
});

test('основные статусы цепочки отмечены как основные', () => {
  for (const status of ['CREATED', 'SORTING_CENTER_AT_START', 'DELIVERY_DELIVERED', 'RETURN_RETURNED', 'CANCELLED']) {
    assert.equal(resolveStatus(status, '').major, true, status);
  }
  // Статусы детализации основными не считаются.
  assert.equal(resolveStatus('SORTING_CENTER_PREPARED', '').major, false);
});

test('проблемные статусы подсвечиваются', () => {
  assert.equal(resolveStatus('VALIDATING_ERROR', '').problem, true);
  assert.equal(resolveStatus('DELIVERY_ATTEMPT_FAILED', '').problem, true);
  assert.equal(resolveStatus('DELIVERY_DELIVERED', '').problem, false);
});

test('незнакомый статус не ломает фильтрацию', () => {
  // Появится новый статус — он попадёт в раздел по имени, а не потеряется.
  assert.equal(resolveStatus('RETURN_SOMETHING_NEW', '').group, 'return');
  assert.equal(resolveStatus('DELIVERY_SOMETHING_NEW', '').group, 'transit');
  assert.equal(resolveStatus('SORTING_CENTER_SOMETHING_NEW', '').group, 'transit');
  assert.equal(resolveStatus('TOTALLY_UNKNOWN', '').group, 'awaiting');
});

test('адрес без full_address собирается из частей', () => {
  assert.equal(
    formatAddress({ locality: 'Москва', street: 'Пролетарский проспект', house: '19', room: '2' }),
    'Москва, Пролетарский проспект, 19, кв. 2',
  );
  assert.equal(formatAddress(null), '');
});

test('полный и частичный невыкуп различаются', () => {
  const build = (items) =>
    normalizeOrder({ ...reportPickup, request: { ...reportPickup.request, items } }, { stations });

  const item = (count, refused) => ({
    count,
    name: 'Товар',
    article: 'A-1',
    billing_details: { unit_price: 100000 },
    place_barcode: 'A',
    refused_count: refused,
  });

  // Отказов нет.
  assert.equal(build([item(2, 0), item(1, 0)]).refusal, 'none');
  // Отказались от всех единиц каждого товара — заказ возвращается целиком.
  assert.equal(build([item(2, 2), item(1, 1)]).refusal, 'full');
  // Часть забрали: по одному товару отказ полный, по другому нет.
  assert.equal(build([item(2, 2), item(1, 0)]).refusal, 'partial');
  // Забрали часть единиц одного товара.
  assert.equal(build([item(3, 1)]).refusal, 'partial');
});

test('этапы шкалы: каждый статус попадает в свой этап', () => {
  const cases = {
    CREATED: 'awaiting',
    VALIDATING_ERROR: 'awaiting',
    SORTING_CENTER_LOADED: 'awaiting',

    SORTING_CENTER_AT_START: 'transit',
    SORTING_CENTER_TRANSMITTED: 'transit',

    DELIVERY_TRANSPORTATION: 'transit',
    DELIVERY_ATTEMPT_FAILED: 'transit',

    DELIVERY_ARRIVED_PICKUP_POINT: 'ready',
    PARTICULARLY_DELIVERED: 'ready',

    RETURN_TRANSPORTATION_STARTED: 'return',
    RETURN_READY_FOR_PICKUP: 'return',

    DELIVERY_DELIVERED: 'done',
    RETURN_RETURNED: 'done',
    CANCELLED: 'done',
  };

  for (const [status, stage] of Object.entries(cases)) {
    assert.equal(resolveStatus(status, '').stage, stage, status);
  }

  // Незнакомый статус получает этап по разделу, а не теряется.
  assert.equal(resolveStatus('DELIVERY_SOMETHING_NEW', '').stage, 'transit');
  assert.equal(resolveStatus('RETURN_SOMETHING_NEW', '').stage, 'return');
});

test('этапы повторяют разделы панели', () => {
  assert.deepEqual(
    STAGES.map((stage) => stage.id),
    ['awaiting', 'transit', 'ready', 'done'],
  );
  assert.deepEqual(
    STAGES.map((stage) => stage.title),
    ['Ожидает отгрузки', 'В пути', 'Готов к вручению', 'Выдан'],
  );
  // У этапа перед выдачей своя подпись для возвратных заказов.
  assert.equal(STAGES[2].returnTitle, 'Возврат');

  // Каждый этап соответствует разделу с тем же идентификатором.
  const tabs = TABS.map((tab) => tab.id);
  for (const stage of STAGES) assert.ok(tabs.includes(stage.id), stage.id);
});
