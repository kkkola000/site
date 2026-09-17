import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { config, ROOT, authEnabled } from './config.js';
import { TABS, isKnownTab } from './statuses.js';
import { getOrders, filterOrders, countByTab, groupByDate, stripInternal, getOrderDetails } from './orders.js';
import { generateLabels, YandexApiError, explain } from './yandex.js';

const PUBLIC_DIR = resolve(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function authorized(req) {
  if (!authEnabled()) return true;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const [user, ...rest] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
  const password = rest.join(':');
  return safeEqual(user || '', config.auth.user) && safeEqual(password || '', config.auth.password);
}

function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  // normalize + префиксная проверка не выпускают запрос за пределы public/.
  const filePath = join(PUBLIC_DIR, normalize(requested));
  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Не найдено');
    return;
  }

  // В index.html подставляем базовый путь: панель может быть смонтирована
  // в подкаталог уже существующего домена (BASE_PATH=/orders).
  if (requested === '/index.html') {
    const html = readFileSync(filePath, 'utf8').replaceAll('__BASE__', config.basePath);
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
    res.end(html);
    return;
  }

  res.writeHead(200, {
    'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
    'Cache-Control': 'public, max-age=300',
  });
  createReadStream(filePath).pipe(res);
}

function apiErrorStatus(err) {
  if (err instanceof YandexApiError) {
    if (err.status === 401 || err.status === 403) return 502;
    if (err.status === 404) return 404;
    return err.status >= 500 || err.status === 0 ? 502 : 400;
  }
  return 500;
}

async function handleApi(req, res, url, pathname) {
  const parts = pathname.split('/').filter(Boolean); // ['api', ...]

  if (pathname === '/api/health') {
    sendJson(res, 200, { ok: true, tokenConfigured: Boolean(config.yandex.token), base: config.yandex.base });
    return;
  }

  if (pathname === '/api/orders') {
    const tabParam = url.searchParams.get('tab') || 'all';
    const tab = isKnownTab(tabParam) ? tabParam : 'all';
    const q = url.searchParams.get('q') || '';
    const force = url.searchParams.get('refresh') === '1';

    const snapshot = await getOrders({ force });
    const filtered = filterOrders(snapshot.orders, { tab, q });
    sendJson(res, 200, {
      tabs: TABS,
      counts: countByTab(snapshot.orders, { q }),
      groups: groupByDate(filtered).map((group) => ({
        date: group.date,
        orders: group.orders.map(stripInternal),
      })),
      total: filtered.length,
      updatedAt: new Date(snapshot.at).toISOString(),
      error: snapshot.error,
    });
    return;
  }

  // /api/orders/:id  и  /api/orders/:id/label
  if (parts[0] === 'api' && parts[1] === 'orders' && parts[2]) {
    const requestId = decodeURIComponent(parts[2]);

    if (parts[3] === 'label') {
      const size = url.searchParams.get('size') || '100x150';
      const { buffer, contentType } = await generateLabels([requestId], { labelSize: size });
      res.writeHead(200, {
        'Content-Type': contentType.includes('pdf') ? 'application/pdf' : contentType,
        'Content-Disposition': `inline; filename="label-${requestId}.pdf"`,
        'Content-Length': buffer.length,
      });
      res.end(buffer);
      return;
    }

    if (!parts[3]) {
      const order = await getOrderDetails(requestId);
      if (!order) {
        sendJson(res, 404, { error: 'Заказ не найден' });
        return;
      }
      sendJson(res, 200, { order });
      return;
    }
  }

  sendJson(res, 404, { error: 'Неизвестный метод' });
}

// Отрезает BASE_PATH, если nginx проксирует запросы вместе с префиксом.
function stripBase(pathname) {
  const base = config.basePath;
  if (!base) return pathname;
  if (pathname === base) return '/';
  if (pathname.startsWith(base + '/')) return pathname.slice(base.length);
  return pathname;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = stripBase(url.pathname);

  if (!authorized(req)) {
    res.writeHead(401, {
      // realm — только ASCII: в заголовках HTTP кириллица недопустима.
      'WWW-Authenticate': 'Basic realm="Orders panel", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
    });
    res.end('Требуется авторизация');
    return;
  }

  if (pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, url, pathname);
    } catch (err) {
      console.error('[api]', pathname, err);
      if (!res.headersSent) sendJson(res, apiErrorStatus(err), { error: explain(err) });
      else res.end();
    }
    return;
  }

  serveStatic(req, res, pathname);
});

server.listen(config.port, config.host, () => {
  // Печатаем фактический порт: при PORT=0 его назначает система.
  const { port } = server.address();
  console.log(`Панель заказов: http://${config.host}:${port}${config.basePath}`);
  console.log(`API Яндекс Доставки: ${config.yandex.base}`);
  if (!config.yandex.token) console.warn('ВНИМАНИЕ: YANDEX_OAUTH_TOKEN не задан — заказы не загрузятся.');
  if (!authEnabled()) console.warn('ВНИМАНИЕ: панель без пароля — задайте AUTH_USER и AUTH_PASSWORD.');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
