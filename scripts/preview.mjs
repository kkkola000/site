// Локальный предпросмотр интерфейса без обращения к боевому API.
// Поднимает заглушку с демо-заказами и саму панель:  node scripts/preview.mjs
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { reportPickup, reportCourier } from '../test/fixtures.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const TOKEN = 'preview';

const done = { ...reportPickup, request_id: 'done-1', courier_order_id: '786459120',
  request: { ...reportPickup.request, info: { operator_request_id: '29991724-0649-1' } },
  state: { status: 'DELIVERY_DELIVERED', description: 'Заказ доставлен', timestamp_utc: '2026-09-15T14:20:00.000000Z' } };
const awaiting = { ...reportPickup, request_id: 'new-1', courier_order_id: '',
  request: { ...reportPickup.request, info: { operator_request_id: '29991724-0650-1' } },
  state: { status: 'CREATED', description: 'Заказ создан в операторе', timestamp_utc: '2026-09-17T08:00:00.000000Z' } };

const stub = createServer((req, res) => {
  const path = req.url.split('?')[0];
  const json = (payload) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
  if (path === '/api/b2b/platform/requests/info') return json({ requests: [reportPickup, reportCourier, done, awaiting] });
  if (path === '/api/b2b/platform/warehouses/list') {
    return json({ warehouses: [{ platform_station_id: 'e1139f6d-e34f-47a9-a55f-31f032a861a6', name: 'Склад ANEX', address: 'Москва, Ленинградский проспект, 27' }] });
  }
  if (path === '/api/b2b/platform/request/info') return json(reportPickup);
  if (path === '/api/b2b/platform/request/history') {
    return json({ state_history: [
      { status: 'CREATED', description: 'Заказ создан в операторе', timestamp_utc: '2026-09-15T10:00:00.000000Z' },
      { status: 'DELIVERY_LOADED', description: 'Заказ принят в доставку', timestamp_utc: '2026-09-16T08:30:00.000000Z' },
      { status: 'DELIVERY_TRANSPORTATION', description: 'Заказ в пути', timestamp_utc: '2026-09-16T12:00:00.000000Z' },
    ] });
  }
  if (path === '/api/b2b/platform/request/actual_info') return json({ delivery_date: '2026-09-17', delivery_interval: { from: '10:00+03:00', to: '18:00+03:00' } });
  res.writeHead(404); res.end('{}');
});

stub.listen(0, '127.0.0.1');
await once(stub, 'listening');

const panel = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, ENV_FILE: '/dev/null', PORT: process.env.PREVIEW_PORT || '4173', HOST: '127.0.0.1',
    YANDEX_API_BASE: `http://127.0.0.1:${stub.address().port}`, YANDEX_OAUTH_TOKEN: TOKEN, CACHE_TTL_SECONDS: '5' },
});

const stop = () => { panel.kill(); stub.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
