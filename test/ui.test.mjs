import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { reportPickup, reportCourier } from './fixtures.mjs';

const ROOT = resolve(import.meta.dirname, '..');

// --- Классы в разметке должны быть описаны в стилях ---

// Из class="badge badge--${...}" остаётся только то, что записано буквально:
// вычисляемые куски статически проверить нельзя.
function withoutInterpolations(value) {
  let text = '';
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (depth === 0 && value[i] === '$' && value[i + 1] === '{') {
      depth = 1;
      i += 1;
    } else if (depth > 0) {
      if (value[i] === '{') depth += 1;
      else if (value[i] === '}') depth -= 1;
    } else {
      text += value[i];
    }
  }
  return text;
}

test('каждый класс из разметки есть в стилях', () => {
  const css = readFileSync(join(ROOT, 'public/styles.css'), 'utf8');
  const sources = ['public/index.html', 'public/app.js'].map((file) =>
    readFileSync(join(ROOT, file), 'utf8'),
  );

  const used = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(/class="([^"]*)"/g)) {
      for (const name of withoutInterpolations(match[1]).split(/\s+/)) {
        if (!name || name.includes('<')) continue;
        used.add(name);
      }
    }
  }

  // Классы, которые навешиваются из кода по состоянию.
  const dynamic = new Set(['is-busy', 'is-done', 'is-current', 'is-problem', 'is-labelled', 'over']);

  const missing = [...used].filter((name) => !dynamic.has(name) && !css.includes(`.${name}`));
  assert.deepEqual(missing, [], `нет правил для классов: ${missing.join(', ')}`);
});

// --- Панель в браузере: без ошибок и с отрисованной шкалой ---

function chromiumPath() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (!existsSync(base)) return '';
  const dir = readdirSync(base).find((name) => name.startsWith('chromium-'));
  if (!dir) return '';
  const binary = join(base, dir, 'chrome-linux', 'chrome');
  return existsSync(binary) ? binary : '';
}

async function startStub() {
  const server = createServer((req, res) => {
    const json = (payload) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const path = req.url.split('?')[0];
    if (path === '/api/b2b/platform/requests/info') return json({ requests: [reportPickup, reportCourier] });
    if (path === '/api/b2b/platform/request/history') {
      return json({
        state_history: [
          { status: 'CREATED', description: 'Заказ создан', timestamp_utc: '2026-09-15T10:00:00.000000Z' },
          { status: 'SORTING_CENTER_AT_START', description: 'Принят в СЦ', timestamp_utc: '2026-09-16T08:00:00.000000Z' },
          { status: 'DELIVERY_TRANSPORTATION', description: 'В пути', timestamp_utc: '2026-09-16T12:00:00.000000Z' },
        ],
      });
    }
    json({});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

// Подключение к браузеру по протоколу CDP: сам адрес из stderr ведёт к браузеру,
// команды страницы (Page, Runtime) идут уже в сессию вкладки.
async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await once(ws, 'open');
  let id = 0;
  const logs = [];
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') {
      logs.push(message.params.exceptionDetails.exception?.description || 'исключение');
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      logs.push(message.params.args.map((a) => a.value || a.description).join(' '));
    }
  });

  const call = (method, params, sessionId) =>
    new Promise((resolveCall, rejectCall) => {
      const callId = ++id;
      const onMessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== callId) return;
        ws.removeEventListener('message', onMessage);
        if (message.error) rejectCall(new Error(`${method}: ${message.error.message}`));
        else resolveCall(message.result);
      };
      ws.addEventListener('message', onMessage);
      ws.send(JSON.stringify({ id: callId, sessionId, method, params }));
    });

  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });

  return {
    send: (method, params) => call(method, params, sessionId),
    logs,
    close: () => ws.close(),
  };
}

test('панель открывается без ошибок и рисует шкалу этапов', async (t) => {
  const chrome = chromiumPath();
  if (!chrome) {
    t.skip('chromium не найден');
    return;
  }

  const stub = await startStub();
  t.after(() => stub.close());

  const panel = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      ENV_FILE: '/dev/null',
      PORT: '0',
      HOST: '127.0.0.1',
      YANDEX_API_BASE: `http://127.0.0.1:${stub.address().port}`,
      YANDEX_OAUTH_TOKEN: 'test',
      SETTINGS_FILE: '/tmp/ui-test-settings.json',
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  t.after(() => panel.kill());

  const port = await new Promise((resolvePort, rejectPort) => {
    const timer = setTimeout(() => rejectPort(new Error('панель не запустилась')), 10000);
    panel.stdout.on('data', (chunk) => {
      const match = String(chunk).match(/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolvePort(match[1]);
      }
    });
  });

  const browser = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--remote-debugging-port=0', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(() => browser.kill());

  const wsUrl = await new Promise((resolveWs, rejectWs) => {
    const timer = setTimeout(() => rejectWs(new Error('браузер не поднялся')), 15000);
    browser.stderr.on('data', (chunk) => {
      const match = String(chunk).match(/ws:\/\/[^\s]+/);
      if (match) {
        clearTimeout(timer);
        resolveWs(match[0]);
      }
    });
  });

  const { send, logs, close } = await cdp(wsUrl);
  t.after(close);

  await send('Runtime.enable', {});
  await send('Page.enable', {});
  // Окно повыше: шкала этапов подгружается только для видимых карточек.
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 2200, deviceScaleFactor: 1, mobile: false,
  });
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await new Promise((r) => setTimeout(r, 3000));

  const { result } = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `({
      cards: document.querySelectorAll('.card').length,
      tracks: document.querySelectorAll('.track').length,
      stages: document.querySelectorAll('.track__point').length,
      statuses: document.querySelectorAll('.badge').length,
      labels: [...document.querySelectorAll('.card .cell__label')].map((node) => node.textContent),
    })`,
  });

  assert.deepEqual(logs, [], `ошибки в консоли: ${logs.join(' | ')}`);
  assert.ok(result.value.cards >= 2, `карточек: ${result.value.cards}`);
  // Шкала рисуется для каждой карточки, по четыре этапа.
  assert.equal(result.value.tracks, result.value.cards);
  assert.equal(result.value.stages, result.value.cards * 4);
  assert.equal(result.value.statuses, result.value.cards);
  // В каждой карточке четыре подписи столбцов: компания, грузоместа, страховка, адрес.
  assert.equal(result.value.labels.length, result.value.cards * 4);
  assert.ok(
    result.value.labels.some((text) => text.startsWith('Грузоместа')),
    `подписи столбцов: ${result.value.labels.join(' | ')}`,
  );
});
