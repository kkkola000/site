import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { reportPickup, reportCourier } from './fixtures.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const TOKEN = 'test-token';
const AUTH = 'Basic ' + Buffer.from('manager:secret').toString('base64');

// Заглушка API Яндекс Доставки: проверяет Bearer-токен и отдаёт документированные ответы.
async function startStub() {
  const calls = [];
  const server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url.split('?')[0]}`);
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'unauthorized', message: 'bad token' }));
      return;
    }
    const url = new URL(req.url, 'http://stub');
    const json = (payload) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (url.pathname === '/api/b2b/platform/requests/info') return json({ requests: [reportPickup, reportCourier] });
    if (url.pathname === '/api/b2b/platform/warehouses/list') {
      return json({
        warehouses: [
          {
            platform_station_id: 'e1139f6d-e34f-47a9-a55f-31f032a861a6',
            name: 'Склад ANEX',
            address: { details: { full_address: 'Москва, Ленинградский проспект, 27' } },
          },
        ],
      });
    }
    if (url.pathname === '/api/b2b/platform/request/info') return json(reportPickup);
    if (url.pathname === '/api/b2b/platform/request/history') {
      return json({
        state_history: [
          { status: 'CREATED', description: 'Заказ создан', timestamp_utc: '2026-09-15T10:00:00.000000Z' },
          { status: 'DELIVERY_TRANSPORTATION', description: 'Заказ в пути', timestamp_utc: '2026-09-16T12:00:00.000000Z' },
        ],
      });
    }
    if (url.pathname === '/api/b2b/platform/request/actual_info') {
      return json({ delivery_date: '2026-09-17', delivery_interval: { from: '10:00+03:00', to: '18:00+03:00' } });
    }
    if (url.pathname === '/api/b2b/platform/request/generate-labels') {
      // Возвращаем в теле полученный размер — тест проверяет, что уходит нужный.
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const payload = JSON.parse(body || '{}');
        const size = payload.label_size_mm || '';
        const layout = payload.generate_type || '';
        const [w, h] = size.split('x').map(Number);
        const box = w && h ? `0 0 ${(w * 72) / 25.4} ${(h * 72) / 25.4}` : '0 0 595.28 841.89';
        res.writeHead(200, { 'Content-Type': 'application/pdf' });
        res.end(Buffer.from(`%PDF-1.4 ${size} ${layout}\n1 0 obj<</Type/Page/MediaBox [${box}]>>endobj`));
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 'not_found', message: 'no such method' }));
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, calls, base: `http://127.0.0.1:${server.address().port}` };
}

async function startPanel(env) {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, ENV_FILE: '/dev/null', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise((resolveP, rejectP) => {
    const timer = setTimeout(() => rejectP(new Error('панель не запустилась')), 10000);
    child.stdout.on('data', (chunk) => {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolveP(Number(match[1]));
      }
    });
    child.stderr.on('data', (chunk) => process.env.DEBUG && console.error(String(chunk)));
  });
  return { child, base: `http://127.0.0.1:${port}` };
}

test('панель отдаёт заказы, разделы, поиск, карточку и ярлык', async (t) => {
  const stub = await startStub();
  const panel = await startPanel({
    PORT: '0',
    HOST: '127.0.0.1',
    YANDEX_API_BASE: stub.base,
    YANDEX_OAUTH_TOKEN: TOKEN,
    AUTH_USER: 'manager',
    AUTH_PASSWORD: 'secret',
    CACHE_TTL_SECONDS: '0',
  });

  t.after(async () => {
    panel.child.kill();
    stub.server.close();
  });

  const get = (path) => fetch(`${panel.base}${path}`, { headers: { Authorization: AUTH } });

  await t.test('без авторизации панель закрыта', async () => {
    const response = await fetch(`${panel.base}/api/orders`);
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate') || '', /Basic/);
  });

  await t.test('раздел «Все»: заказы, счётчики и группировка по датам', async () => {
    const data = await (await get('/api/orders')).json();
    assert.equal(data.total, 2);
    assert.equal(data.counts.all, 2);
    assert.equal(data.counts.transit, 1);
    assert.equal(data.counts.return, 1);
    assert.equal(data.error, null);
    assert.equal(
      data.tabs.map((tab) => tab.title).join(','),
      'Все,Ожидает отгрузки,В пути,Готов к вручению,Возврат,Завершены',
    );

    const order = data.groups.flatMap((group) => group.orders).find((o) => o.orderNumber === 'lKF4565ml');
    assert.equal(order.trackNumber, '786459112');
    assert.equal(order.totalPrice, 23000);
    // Адрес отгрузки подтянулся из warehouses/list.
    assert.equal(order.shipment.address, 'Москва, Ленинградский проспект, 27');
  });

  await t.test('фильтр по разделу', async () => {
    const data = await (await get('/api/orders?tab=return')).json();
    assert.equal(data.total, 1);
    assert.equal(data.groups[0].orders[0].status.group, 'return');
  });

  await t.test('поиск по названию товара и по артикулу', async () => {
    const byName = await (await get(`/api/orders?q=${encodeURIComponent('сумка anex')}`)).json();
    assert.equal(byName.total, 1);
    const byArticle = await (await get(`/api/orders?q=${encodeURIComponent('ET-01')}`)).json();
    assert.equal(byArticle.total, 1);
    const empty = await (await get('/api/orders?q=неттакого')).json();
    assert.equal(empty.total, 0);
  });

  await t.test('карточка заказа с историей статусов', async () => {
    const data = await (await get('/api/orders/77241d8009bb46d0bff5c65a73077bcd-udp')).json();
    assert.equal(data.order.orderNumber, 'lKF4565ml');
    assert.equal(data.order.history.length, 2);
    // История отсортирована от свежего к старому.
    assert.equal(data.order.history[0].code, 'DELIVERY_TRANSPORTATION');
    assert.equal(data.order.actual.deliveryDate, '2026-09-17');
  });

  await t.test('ярлык печатается в формате 58x40 по умолчанию', async () => {
    const response = await get('/api/orders/77241d8009bb46d0bff5c65a73077bcd-udp/label');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/pdf');
    assert.match(response.headers.get('content-disposition'), /58x40\.pdf/);
    // Панель сверяет размер страницы в самом PDF: видно, что вернулась этикетка, а не A4.
    assert.equal(response.headers.get('x-label-requested-mm'), '58x40');
    assert.equal(response.headers.get('x-label-actual-mm'), '58x40');
    assert.match(await response.text(), /^%PDF-1\.4 58x40 one/);
  });

  await t.test('формат можно выбрать в карточке заказа', async () => {
    const response = await get('/api/orders/77241d8009bb46d0bff5c65a73077bcd-udp/label?size=100x150');
    assert.equal(response.headers.get('x-label-actual-mm'), '100x150');
    assert.match(await response.text(), /^%PDF-1\.4 100x150/);
  });

  await t.test('неизвестный формат не уходит в API', async () => {
    // Иначе Яндекс Доставка ответит ошибкой вместо ярлыка.
    const response = await get('/api/orders/77241d8009bb46d0bff5c65a73077bcd-udp/label?size=13x37');
    assert.match(await response.text(), /^%PDF-1\.4 58x40/);
  });

  await t.test('статика панели отдаётся, выход за public/ невозможен', async () => {
    assert.equal((await get('/')).status, 200);
    assert.equal((await get('/app.js')).status, 200);
    assert.equal((await get('/../server/config.js')).status, 404);
  });
});

test('битый токен: панель показывает понятную ошибку, а не падает', async (t) => {
  const stub = await startStub();
  const panel = await startPanel({
    PORT: '0',
    HOST: '127.0.0.1',
    YANDEX_API_BASE: stub.base,
    YANDEX_OAUTH_TOKEN: 'wrong-token',
  });
  t.after(async () => {
    panel.child.kill();
    stub.server.close();
  });

  const data = await (await fetch(`${panel.base}/api/orders`)).json();
  assert.equal(data.total, 0);
  assert.match(data.error, /токен/i);
});

test('панель работает под подпутём существующего домена (BASE_PATH)', async (t) => {
  const stub = await startStub();
  const panel = await startPanel({
    PORT: '0',
    HOST: '127.0.0.1',
    BASE_PATH: '/orders',
    YANDEX_API_BASE: stub.base,
    YANDEX_OAUTH_TOKEN: TOKEN,
  });
  t.after(async () => {
    panel.child.kill();
    stub.server.close();
  });

  // nginx передаёт префикс как есть
  const withPrefix = await fetch(`${panel.base}/orders/api/orders`);
  assert.equal(withPrefix.status, 200);
  assert.equal((await withPrefix.json()).total, 2);

  // nginx срезает префикс (proxy_pass со слэшем на конце) — тоже работает
  const withoutPrefix = await fetch(`${panel.base}/api/orders`);
  assert.equal(withoutPrefix.status, 200);

  // В HTML подставлен базовый путь, ссылки на статику ведут внутрь подпути
  const html = await (await fetch(`${panel.base}/orders/`)).text();
  assert.match(html, /<meta name="base-path" content="\/orders">/);
  assert.match(html, /href="\/orders\/styles\.css"/);
  assert.ok(!html.includes('__BASE__'));
});

test('токен вводится в панели: сохранение, маскирование, загрузка заказов', async (t) => {
  const stub = await startStub();
  t.after(() => stub.server.close());

  const settingsFile = join(mkdtempSync(join(tmpdir(), 'settings-')), 'settings.json');
  const panel = await startPanel({
    PORT: '0',
    HOST: '127.0.0.1',
    YANDEX_API_BASE: stub.base,
    YANDEX_OAUTH_TOKEN: '',          // в .env токена нет — только через панель
    SETTINGS_FILE: settingsFile,
  });
  t.after(() => panel.child.kill());

  const json = async (path, init) => (await fetch(`${panel.base}${path}`, init)).json();

  await t.test('без токена панель просит настройку, а не показывает ошибку', async () => {
    const data = await json('/api/orders');
    assert.equal(data.needsToken, true);
    assert.equal(data.error, null);
    assert.equal(data.total, 0);
    // В API не ходили: заглушка не получила ни одного запроса.
    assert.equal(stub.calls.length, 0);
  });

  await t.test('проверка связи с неверным токеном возвращает причину', async () => {
    await json('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'wrong' }),
    });
    const result = await json('/api/settings/test', { method: 'POST' });
    assert.equal(result.ok, false);
    assert.match(result.message, /токен/i);
  });

  await t.test('сохранённый токен применяется сразу, без перезапуска', async () => {
    const saved = await json('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN, stationIds: 'e1139f6d-e34f-47a9-a55f-31f032a861a6' }),
    });
    assert.equal(saved.tokenSet, true);
    assert.equal(saved.tokenSource, 'panel');

    const result = await json('/api/settings/test', { method: 'POST' });
    assert.equal(result.ok, true, result.message);

    const orders = await json('/api/orders');
    assert.equal(orders.needsToken, false);
    assert.equal(orders.total, 2);
  });

  await t.test('полный токен в браузер не возвращается', async () => {
    const view = await json('/api/settings');
    assert.equal(view.tokenSet, true);
    assert.ok(!JSON.stringify(view).includes(TOKEN), 'токен не должен уходить в ответе');
    assert.match(view.tokenMask, /…/);
  });

  await t.test('файл настроек доступен только владельцу (600)', () => {
    assert.equal(statSync(settingsFile).mode & 0o777, 0o600);
    assert.match(readFileSync(settingsFile, 'utf8'), /"token": "test-token"/);
  });

  await t.test('токен удаляется явно, и панель возвращается к экрану подключения', async () => {
    const cleared = await json('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: '' }),
    });
    assert.equal(cleared.tokenSet, false);
    assert.equal(cleared.tokenSource, 'none');

    // В файле настроек токена не осталось.
    assert.match(readFileSync(settingsFile, 'utf8'), /"token": ""/);

    const orders = await json('/api/orders');
    assert.equal(orders.needsToken, true);
    assert.equal(orders.total, 0);

    // Возвращаем токен для следующего шага.
    await json('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
    });
  });

  await t.test('пустое поле токена не стирает сохранённый', async () => {
    await json('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stationIds: '' }),
    });
    const view = await json('/api/settings');
    assert.equal(view.tokenSet, true);
    assert.equal(view.stationIds.length, 0);
  });
});

test('формат ярлыка по умолчанию меняется в настройках', async (t) => {
  const stub = await startStub();
  t.after(() => stub.server.close());

  const settingsFile = join(mkdtempSync(join(tmpdir(), 'settings-')), 'settings.json');
  const panel = await startPanel({
    PORT: '0',
    HOST: '127.0.0.1',
    YANDEX_API_BASE: stub.base,
    YANDEX_OAUTH_TOKEN: TOKEN,
    SETTINGS_FILE: settingsFile,
  });
  t.after(() => panel.child.kill());

  const json = async (path, init) => (await fetch(`${panel.base}${path}`, init)).json();

  const before = await json('/api/settings');
  assert.equal(before.labelSize, '58x40');
  assert.ok(before.labelSizes.some((size) => size.value === '58x40'));

  const saved = await json('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ labelSize: '75x120' }),
  });
  assert.equal(saved.labelSize, '75x120');

  const label = await fetch(`${panel.base}/api/orders/77241d8009bb46d0bff5c65a73077bcd-udp/label`);
  assert.equal(label.headers.get('x-label-actual-mm'), '75x120');
  assert.match(await label.text(), /^%PDF-1\.4 75x120/);

  // Недопустимое значение не затирает сохранённое.
  const ignored = await json('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ labelSize: 'A3' }),
  });
  assert.equal(ignored.labelSize, '75x120');
});

test('раскладка ярлыков на странице настраивается', async (t) => {
  const stub = await startStub();
  t.after(() => stub.server.close());

  const settingsFile = join(mkdtempSync(join(tmpdir(), 'settings-')), 'settings.json');
  const panel = await startPanel({
    PORT: '0',
    HOST: '127.0.0.1',
    YANDEX_API_BASE: stub.base,
    YANDEX_OAUTH_TOKEN: TOKEN,
    SETTINGS_FILE: settingsFile,
  });
  t.after(() => panel.child.kill());

  const json = async (path, init) => (await fetch(`${panel.base}${path}`, init)).json();
  const label = (query = '') =>
    fetch(`${panel.base}/api/orders/77241d8009bb46d0bff5c65a73077bcd-udp/label${query}`).then((r) => r.text());

  // По умолчанию — one, как в рабочем запросе к API.
  assert.equal((await json('/api/settings')).labelLayout, 'one');
  assert.match(await label(), /58x40 one/);

  const saved = await json('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ labelLayout: 'many' }),
  });
  assert.equal(saved.labelLayout, 'many');
  assert.match(await label(), /58x40 many/);

  // Разовая печать может переопределить раскладку, не меняя настройку.
  assert.match(await label('?layout=one'), /58x40 one/);
  assert.equal((await json('/api/settings')).labelLayout, 'many');

  // Недопустимое значение не затирает сохранённое и не уходит в API.
  const ignored = await json('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ labelLayout: 'grid' }),
  });
  assert.equal(ignored.labelLayout, 'many');
  assert.match(await label('?layout=grid'), /58x40 many/);
});
