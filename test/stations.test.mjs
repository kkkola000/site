import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

// Заглушка API поднимается до импорта модуля: config читает окружение при загрузке.
const calls = [];
const bodies = [];
let pickupPoints = [];
let warehouse = null;

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    const path = req.url.split('?')[0];
    calls.push(path);
    bodies.push(JSON.parse(raw || '{}'));
    const json = (payload) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (path === '/api/b2b/platform/warehouses/list') {
      return json({
        warehouses: [
          {
            platform_station_id: 'wh-1',
            name: 'Склад ANEX',
            address: { details: { full_address: 'Москва, Ленинградский проспект, 27' } },
          },
        ],
      });
    }
    if (path === '/api/b2b/platform/pickup-points/list') return json({ points: pickupPoints });
    if (path === '/api/b2b/platform/warehouses/retrieve') {
      if (!warehouse) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ code: 'not_found', message: 'Warehouse not found' }));
      }
      return json({ warehouse });
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 'not_found', message: 'no such method' }));
  });
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');

process.env.ENV_FILE = '/dev/null';
process.env.SETTINGS_FILE = '/dev/null';
process.env.YANDEX_OAUTH_TOKEN = 'stations-test';
process.env.YANDEX_API_BASE = `http://127.0.0.1:${server.address().port}`;

const { resolveStations, resetStations } = await import('../server/stations.js');

test.after(() => server.close());

test.beforeEach(() => {
  resetStations();
  calls.length = 0;
  bodies.length = 0;
  pickupPoints = [];
  warehouse = null;
});

test('адрес ПВЗ берётся из pickup-points/list по идентификаторам', async () => {
  pickupPoints = [
    {
      id: '019db9ba679670c88a8eed71cad5e6c1',
      name: 'Пункт выдачи Яндекс Маркета',
      address: { full_address: 'Москва, Профсоюзная улица, 45' },
    },
  ];

  const stations = await resolveStations(['019db9ba679670c88a8eed71cad5e6c1']);
  assert.deepEqual(stations.get('019db9ba679670c88a8eed71cad5e6c1'), {
    name: 'Пункт выдачи Яндекс Маркета',
    address: 'Москва, Профсоюзная улица, 45',
  });

  // Запрос уходит фильтром по нужным точкам, а не за всем списком ПВЗ страны.
  const body = bodies[calls.indexOf('/api/b2b/platform/pickup-points/list')];
  assert.deepEqual(body.pickup_points_ids, ['019db9ba679670c88a8eed71cad5e6c1']);
});

test('адрес собирается из частей, когда full_address не заполнен', async () => {
  pickupPoints = [
    {
      platform_station_id: 'pvz-2',
      title: 'Постамат',
      location: { address: { city: 'Химки', street: 'Ленинградская улица', house: '1', building: '2' } },
    },
  ];

  const stations = await resolveStations(['pvz-2']);
  assert.equal(stations.get('pvz-2').address, 'Химки, Ленинградская улица, 1, стр. 2');
  assert.equal(stations.get('pvz-2').name, 'Постамат');
});

test('если точки нет среди ПВЗ, она запрашивается через warehouses/retrieve', async () => {
  warehouse = {
    station_id: 'wh-2',
    name: 'Склад МСК',
    location: { address: { city: 'Москва', street: 'улица Маршала Василевского', house: '13 к1' } },
  };

  const stations = await resolveStations(['wh-2']);
  assert.equal(stations.get('wh-2').address, 'Москва, улица Маршала Василевского, 13 к1');
  assert.ok(calls.includes('/api/b2b/platform/warehouses/retrieve'));
});

test('склады из warehouses/list не дозапрашиваются', async () => {
  const stations = await resolveStations(['wh-1']);
  assert.equal(stations.get('wh-1').address, 'Москва, Ленинградский проспект, 27');
  assert.ok(!calls.includes('/api/b2b/platform/pickup-points/list'));
});

test('найденная точка и неудачный поиск запоминаются: повторных запросов нет', async () => {
  pickupPoints = [{ id: 'pvz-3', address: 'Казань, Баумана, 1' }];

  await resolveStations(['pvz-3', 'нет-такой']);
  const first = calls.filter((path) => path !== '/api/b2b/platform/warehouses/list').length;

  await resolveStations(['pvz-3', 'нет-такой']);
  const second = calls.filter((path) => path !== '/api/b2b/platform/warehouses/list').length;
  assert.equal(second, first, 'второй заход не должен ходить в API');
});

test('недоступный справочник не ломает выдачу: остаются известные точки', async () => {
  pickupPoints = null; // JSON.stringify(null) — ответ не похож на список
  const stations = await resolveStations(['pvz-4']);
  assert.equal(stations.has('pvz-4'), false);
  assert.equal(stations.get('wh-1').name, 'Склад ANEX');
});
