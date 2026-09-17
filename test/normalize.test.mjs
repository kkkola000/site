import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOrder, searchIndex, formatAddress } from '../server/normalize.js';
import { resolveStatus, TABS } from '../server/statuses.js';
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
  assert.equal(order.status.reasonLabel, 'Получатель передумал');
  assert.equal(order.totalPrice, 240000);
  assert.equal(order.deliveryCost, 500);
  assert.equal(order.partialRefusal, true);
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

test('статусы раскладываются по разделам панели, неизвестные — по шаблону', () => {
  const groups = TABS.map((tab) => tab.id);
  const cases = {
    CREATED: 'awaiting',
    DELIVERY_TRANSPORTATION: 'transit',
    DELIVERY_DELIVERED: 'done',
    RETURNING: 'return',
    CANCELLED: 'done',
    SOMETHING_RETURN_NEW: 'return',
    TOTALLY_UNKNOWN: 'awaiting',
  };
  for (const [status, expected] of Object.entries(cases)) {
    const resolved = resolveStatus(status, '');
    assert.equal(resolved.group, expected, `${status} → ${resolved.group}`);
    assert.ok(groups.includes(resolved.group));
  }
  assert.equal(resolveStatus('ERROR', '').problem, true);
});

test('адрес без full_address собирается из частей', () => {
  assert.equal(
    formatAddress({ locality: 'Москва', street: 'Пролетарский проспект', house: '19', room: '2' }),
    'Москва, Пролетарский проспект, 19, кв. 2',
  );
  assert.equal(formatAddress(null), '');
});
