import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(import.meta.dirname, '../deploy/deploy.sh');

// Функции скрипта подключаются с DEPLOY_LIB_ONLY=1 — установка при этом не выполняется.
function runBash(snippet) {
  return execFileSync('bash', ['-c', `DEPLOY_LIB_ONLY=1 source "${SCRIPT}"\n${snippet}`], {
    encoding: 'utf8',
    env: { ...process.env, DEPLOY_LIB_ONLY: '1' },
  });
}

test('set_env заменяет значение, не ломая остальные строки и комментарии', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-'));
  const file = join(dir, '.env');
  writeFileSync(file, '# комментарий\nPORT=3000\nYANDEX_OAUTH_TOKEN=\nAUTH_USER=manager\n');

  runBash(`set_env "${file}" PORT 3010; set_env "${file}" AUTH_USER boss`);
  const content = readFileSync(file, 'utf8');

  assert.match(content, /^PORT=3010$/m);
  assert.match(content, /^AUTH_USER=boss$/m);
  assert.match(content, /^# комментарий$/m);
  assert.equal(content.match(/^PORT=/gm).length, 1);
});

test('токен со спецсимволами записывается и читается без искажений', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-'));
  const file = join(dir, '.env');
  writeFileSync(file, 'YANDEX_OAUTH_TOKEN=\n');

  // В токенах Яндекса встречаются /, +, = и _ — sed на таких значениях ломается.
  const token = 'y2_AgAAAAD04o/mr+AAAPeAAA==_x';
  runBash(`set_env "${file}" YANDEX_OAUTH_TOKEN '${token}'`);

  assert.equal(readFileSync(file, 'utf8').trim(), `YANDEX_OAUTH_TOKEN=${token}`);
  assert.equal(runBash(`read_env "${file}" YANDEX_OAUTH_TOKEN`).trim(), token);
});

test('отсутствующий ключ добавляется в конец файла', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-'));
  const file = join(dir, '.env');
  writeFileSync(file, 'PORT=3010\n');

  runBash(`set_env "${file}" BASE_PATH /orders`);
  assert.match(readFileSync(file, 'utf8'), /^BASE_PATH=\/orders$/m);
});

test('справка и разбор аргументов работают без root', () => {
  const help = execFileSync('bash', [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.match(help, /--base-path/);
  assert.match(help, /nginx на сервере уже настроен/);

  assert.throws(
    () => execFileSync('bash', [SCRIPT, '--что-то'], { encoding: 'utf8', stdio: 'pipe' }),
    /неизвестный аргумент/,
  );
});

// --- Соседство с панелью Ozon Pack на том же сервере ---

test('список сетей VPN берётся из IP_ALLOWLIST соседней панели', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ozon-'));
  writeFileSync(join(dir, '.env'), 'PORT=8080\nIP_ALLOWLIST=10.8.0.0/24,192.168.10.0/24\n');

  const list = runBash(`OZON_DIR="${dir}"; neighbour_allowlist`).trim();
  assert.equal(list, '10.8.0.0/24,192.168.10.0/24');
});

test('если IP_ALLOWLIST нет, сети читаются из снипета nginx соседа', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ozon-'));
  const snippet = join(dir, 'ozon-pack-access.conf');
  writeFileSync(join(dir, '.env'), 'PORT=8080\n');
  writeFileSync(snippet, 'allow 127.0.0.1;\nallow ::1;\nallow 10.8.0.0/24;\ndeny all;\n');

  const list = runBash(`OZON_DIR="${dir}"; OZON_SNIPPET="${snippet}"; neighbour_allowlist`).trim();
  assert.equal(list, '10.8.0.0/24');
});

test('порт соседа читается из его .env, а не берётся жёстко', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ozon-'));
  writeFileSync(join(dir, '.env'), 'PORT=8090\n');
  assert.equal(runBash(`OZON_DIR="${dir}"; neighbour_port`).trim(), '8090');
  // Без .env остаётся значение по умолчанию.
  assert.equal(runBash(`OZON_DIR="${dir}/нет"; neighbour_port`).trim(), '8080');
});

test('снипет доступа закрывает всё, кроме localhost и заданных сетей', () => {
  const dir = mkdtempSync(join(tmpdir(), 'snippet-'));
  const file = join(dir, 'access.conf');

  runBash(`ACCESS_SNIPPET="${file}"; ALLOW_SUBNETS="10.8.0.0/24,172.16.5.0/24"; write_access_snippet`);
  const conf = readFileSync(file, 'utf8');

  assert.match(conf, /^allow 127\.0\.0\.1;$/m);
  assert.match(conf, /^allow 10\.8\.0\.0\/24;$/m);
  assert.match(conf, /^allow 172\.16\.5\.0\/24;$/m);
  assert.match(conf, /^deny all;$/m);
  assert.ok(!/^allow all;$/m.test(conf));
});

test('без известных сетей снипет не притворяется закрытым', () => {
  const dir = mkdtempSync(join(tmpdir(), 'snippet-'));
  const file = join(dir, 'access.conf');

  runBash(`ACCESS_SNIPPET="${file}"; ALLOW_SUBNETS=""; OZON_DIR="${dir}/нет"; OZON_SNIPPET="${dir}/нет"; write_access_snippet`);
  const conf = readFileSync(file, 'utf8');

  assert.match(conf, /^allow all;$/m);
  assert.ok(!/^deny all;$/m.test(conf));
});

test('шаблон сайта nginx подключает файл правил доступа', () => {
  const template = readFileSync(resolve(import.meta.dirname, '../deploy/nginx.conf'), 'utf8');
  assert.match(template, /include __ACCESS_SNIPPET__;/);
  assert.match(template, /proxy_pass http:\/\/127\.0\.0\.1:__PORT__;/);
});

test('адрес клиента VPN приводится к сети, которую принимает nginx', () => {
  const cases = {
    '10.66.66.2/24': '10.66.66.0/24',   // адрес клиента WireGuard → сеть туннеля
    '10.66.66.0/24': '10.66.66.0/24',
    '10.66.66.2': '10.66.66.2/32',      // одиночный адрес
    '192.168.1.130/16': '192.168.0.0/16',
    '10.8.0.0/24': '10.8.0.0/24',
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(runBash(`normalize_cidr '${input}'`).trim(), expected, input);
  }
});

test('нераспознанная запись не попадает в конфиг nginx', () => {
  const dir = mkdtempSync(join(tmpdir(), 'snippet-'));
  const file = join(dir, 'access.conf');

  runBash(`ACCESS_SNIPPET="${file}"; DIR="${dir}"; ALLOW_SUBNETS="10.66.66.2/24,мусор,10.66.66.300/24"; write_access_snippet`);
  const conf = readFileSync(file, 'utf8');

  assert.match(conf, /^allow 10\.66\.66\.0\/24;$/m);
  assert.match(conf, /^deny all;$/m);
  assert.ok(!conf.includes('мусор'));
  assert.ok(!conf.includes('10.66.66.300'));
  // В файле только директивы nginx и комментарии — ничего постороннего.
  for (const line of conf.split('\n').filter(Boolean)) {
    assert.match(line, /^(#|allow [\da-f:./]+;$|deny all;$)/i, line);
  }
});

test('список сетей сохраняется и переживает повторный запуск без флага', () => {
  const dir = mkdtempSync(join(tmpdir(), 'snippet-'));
  const file = join(dir, 'access.conf');
  writeFileSync(join(dir, '.env'), 'PORT=3010\n');

  runBash(`ACCESS_SNIPPET="${file}"; DIR="${dir}"; RUN_USER="$(id -un)"; ALLOW_SUBNETS="10.66.66.2/24"; write_access_snippet`);
  assert.match(readFileSync(join(dir, '.env'), 'utf8'), /^ALLOW_SUBNETS=10\.66\.66\.0\/24$/m);

  // Повторный запуск без флага и без соседней панели: доступ остаётся закрытым.
  runBash(`ACCESS_SNIPPET="${file}"; DIR="${dir}"; RUN_USER="$(id -un)"; ALLOW_SUBNETS=""; OZON_DIR="${dir}/нет"; OZON_SNIPPET="${dir}/нет"; write_access_snippet`);
  const conf = readFileSync(file, 'utf8');
  assert.match(conf, /^allow 10\.66\.66\.0\/24;$/m);
  assert.match(conf, /^deny all;$/m);
});

// --- Развёртывание одной командой ---

test('bootstrap передаёт аргументы в deploy.sh без изменений', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bootstrap-'));
  execFileSync('mkdir', ['-p', join(dir, 'deploy')]);
  writeFileSync(join(dir, 'deploy/deploy.sh'), '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n');

  const out = execFileSync(
    'bash',
    [resolve(import.meta.dirname, '../deploy/bootstrap.sh'), '--port', '3010', '--allow-subnet', '10.66.66.0/24'],
    { encoding: 'utf8', env: { ...process.env, SKIP_CLONE: '1', SRC: dir, EUID: '0' } },
  );

  // Клонирование пропущено, аргументы дошли до установщика как есть.
  assert.match(out, /^--port$/m);
  assert.match(out, /^3010$/m);
  assert.match(out, /^--allow-subnet$/m);
  assert.match(out, /^10\.66\.66\.0\/24$/m);
});

test('bootstrap останавливается, если кода нет', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bootstrap-'));
  assert.throws(
    () =>
      execFileSync('bash', [resolve(import.meta.dirname, '../deploy/bootstrap.sh')], {
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, SKIP_CLONE: '1', SRC: dir },
      }),
    /нет deploy\/deploy\.sh/,
  );
});

// --- Встраивание пути в уже работающий сайт nginx ---

const SITE_SAMPLE = `# Создано deploy/ssl.sh для Ozon Pack. Правки перезапишутся при повторном запуске.
server {
    listen 80;
    server_name seller.anex-online.kz;

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    server_name seller.anex-online.kz;

    location / {
        include /etc/nginx/snippets/ozon-pack-access.conf;
        proxy_pass http://127.0.0.1:8080;
    }
}
`;

const withBlock = (file, port = 8080) =>
  runBash(
    `BASE_PATH=/anex-orders; PORT=3010; ACCESS_SNIPPET=/etc/nginx/snippets/anex-orders-access.conf\n` +
      `insert_block "${file}" ${port} "$(location_block)"`,
  );

test('путь добавляется в блок сайта, который проксирует на соседнюю панель', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'site-')), 'site.conf');
  writeFileSync(file, SITE_SAMPLE);

  const out = withBlock(file);
  const blocks = out.split(/^server \{$/m);

  assert.equal(blocks.length, 3, 'должно остаться два блока server');
  // Блок редиректа на https не тронут.
  assert.ok(!blocks[1].includes('anex-orders'), 'редирект не должен получить наш путь');
  // Рабочий блок получил путь и сохранил чужой location.
  assert.match(blocks[2], /location \/anex-orders\/ \{/);
  assert.match(blocks[2], /proxy_pass http:\/\/127\.0\.0\.1:3010\/anex-orders\/;/);
  assert.match(blocks[2], /proxy_pass http:\/\/127\.0\.0\.1:8080;/);
  assert.match(blocks[2], /location = \/anex-orders \{ return 301 \/anex-orders\/; \}/);
});

test('повторный запуск не плодит дубли, снятие возвращает файл как был', () => {
  const dir = mkdtempSync(join(tmpdir(), 'site-'));
  const file = join(dir, 'site.conf');
  writeFileSync(file, SITE_SAMPLE);

  writeFileSync(file, withBlock(file));
  // Повтор: сначала снимаем прошлую вставку, затем вставляем заново.
  const stripped = join(dir, 'stripped.conf');
  writeFileSync(stripped, runBash(`strip_block "${file}"`));
  writeFileSync(file, withBlock(stripped));

  const out = readFileSync(file, 'utf8');
  assert.equal(out.match(/location \/anex-orders\/ \{/g).length, 1, 'блок должен быть один');

  // Полное снятие возвращает исходный конфиг.
  assert.equal(runBash(`strip_block "${file}"`), SITE_SAMPLE);
});

test('если подходящего блока нет, вставка не выполняется', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'site-')), 'site.conf');
  writeFileSync(file, SITE_SAMPLE);

  // Порт другой панели — совпадений нет, файл остаётся прежним.
  const out = withBlock(file, 9999);
  assert.ok(!out.includes('anex-orders'), 'чужой конфиг не должен меняться');
  assert.equal(out, SITE_SAMPLE);
});

// --- Поиск сайта в конфигурации nginx ---

const NGINX_T_OUTPUT = `# configuration file /etc/nginx/nginx.conf:
http {
    include /etc/nginx/sites-enabled/*;
}

# configuration file /etc/nginx/sites-enabled/ozon-pack:
server {
    server_name seller.anex-online.kz;
    location / {
        proxy_pass http://127.0.0.1:8080;
    }
}

# configuration file /etc/nginx/plesk.conf.d/vhosts/shop.anex-online.kz.conf:
server {
    server_name shop.anex-online.kz www.shop.anex-online.kz;
    location / {
        proxy_pass http://127.0.0.1:7080;
    }
}
`;

// Подменяем nginx на заглушку, которая печатает готовый дамп конфигурации.
function withFakeNginx(snippet) {
  const dir = mkdtempSync(join(tmpdir(), 'bin-'));
  const dump = join(dir, 'dump.txt');
  writeFileSync(dump, NGINX_T_OUTPUT);
  writeFileSync(join(dir, 'nginx'), `#!/usr/bin/env bash\n[ "$1" = "-T" ] && cat "${dump}"\nexit 0\n`);
  execFileSync('chmod', ['+x', join(dir, 'nginx')]);
  return runBash(`export PATH="${dir}:$PATH"\n${snippet}`);
}

test('сайт находится по домену', () => {
  const out = withFakeNginx('resolve_site_file "" seller.anex-online.kz 8080');
  assert.equal(out.trim(), '/etc/nginx/sites-enabled/ozon-pack');
});

test('сайт находится по порту соседней панели, если домен не задан', () => {
  assert.equal(withFakeNginx('resolve_site_file "" "" 8080').trim(), '/etc/nginx/sites-enabled/ozon-pack');
  assert.equal(
    withFakeNginx('resolve_site_file "" "" 7080').trim(),
    '/etc/nginx/plesk.conf.d/vhosts/shop.anex-online.kz.conf',
  );
});

test('домен с несколькими именами в server_name тоже находится', () => {
  const out = withFakeNginx('resolve_site_file "" www.shop.anex-online.kz 9999');
  assert.equal(out.trim(), '/etc/nginx/plesk.conf.d/vhosts/shop.anex-online.kz.conf');
});

test('когда сайт не найден, возвращается ошибка, а не случайный путь', () => {
  // Раньше пустой результат превращался в текущий каталог (/root).
  assert.throws(
    () => withFakeNginx('cd /root 2>/dev/null || cd /; resolve_site_file "" нет-такого.example 9999 || exit 3'),
    /Command failed/,
  );
  const listing = withFakeNginx('list_sites');
  assert.match(listing, /seller\.anex-online\.kz/);
  assert.match(listing, /\/etc\/nginx\/sites-enabled\/ozon-pack/);
});

test('явно указанный несуществующий файл отвергается', () => {
  assert.throws(() => withFakeNginx('resolve_site_file /нет/такого.conf "" 8080'), /файл сайта не найден/);
});

// --- Обновление уже настроенной установки ---

function loadConfig(envContent, args = '') {
  const dir = mkdtempSync(join(tmpdir(), 'update-'));
  writeFileSync(join(dir, '.env'), envContent);
  // Разбор аргументов делает сам скрипт, поэтому запускаем его как при установке.
  return runBash(
    `DIR="${dir}"\n` +
      (args ? `${args}\n` : '') +
      `load_existing_config >/dev/null\n` +
      `printf "PORT=%s\\nBASE_PATH=%s\\nBIND=%s\\nSITE=%s\\nDOMAIN=%s\\n" "$PORT" "$BASE_PATH" "${'$'}{BIND_HOST:-}" "${'$'}{SAVED_SITE:-}" "$DOMAIN"`,
  );
}

test('обновление без флагов сохраняет порт, подпуть и адрес прослушивания', () => {
  const out = loadConfig('PORT=3020\nBASE_PATH=/anex-orders\nHOST=10.66.66.1\n');
  assert.match(out, /^PORT=3020$/m);
  assert.match(out, /^BASE_PATH=\/anex-orders$/m);
  assert.match(out, /^BIND=10\.66\.66\.1$/m);
});

test('переданный флаг важнее сохранённого значения', () => {
  const out = loadConfig('PORT=3020\nBASE_PATH=/anex-orders\n', 'PORT=3030; PORT_SET=1');
  assert.match(out, /^PORT=3030$/m);
  assert.match(out, /^BASE_PATH=\/anex-orders$/m);
});

test('панель в корне сайта не получает подпуть при обновлении', () => {
  // Пустой BASE_PATH — это значение, а не «не задано».
  const out = loadConfig('PORT=3010\nBASE_PATH=\nHOST=127.0.0.1\n');
  assert.match(out, /^BASE_PATH=$/m);
  assert.match(out, /^BIND=$/m);
});

test('обновление помнит, в какой сайт nginx встроена панель', () => {
  const out = loadConfig(
    'PORT=3010\nBASE_PATH=/anex-orders\nNGINX_SITE=/etc/nginx/sites-available/ozon-pack\nNGINX_DOMAIN=seller.anex-online.kz\n',
  );
  assert.match(out, /^SITE=\/etc\/nginx\/sites-available\/ozon-pack$/m);
  assert.match(out, /^DOMAIN=seller\.anex-online\.kz$/m);
});

test('первая установка работает без сохранённых значений', () => {
  const dir = mkdtempSync(join(tmpdir(), 'update-'));
  const out = runBash(
    `DIR="${dir}"\nload_existing_config >/dev/null\nprintf "PORT=%s\\nSITE=%s\\n" "$PORT" "\${SAVED_SITE:-}"`,
  );
  assert.match(out, /^PORT=3010$/m);
  assert.match(out, /^SITE=$/m);
});

test('обновление кода не трогает токен, настройки и .env', () => {
  const src = mkdtempSync(join(tmpdir(), 'src-'));
  const dest = mkdtempSync(join(tmpdir(), 'dest-'));

  // Репозиторий: новая версия кода.
  execFileSync('mkdir', ['-p', join(src, 'server'), join(src, 'config')]);
  writeFileSync(join(src, 'server/index.js'), 'новая версия\n');
  writeFileSync(join(src, 'config/stations.example.json'), '{}\n');

  // Установка на сервере: рабочие данные и файл, удалённый из репозитория.
  execFileSync('mkdir', ['-p', join(dest, 'server'), join(dest, 'config')]);
  writeFileSync(join(dest, '.env'), 'YANDEX_OAUTH_TOKEN=из-env\n');
  writeFileSync(join(dest, 'config/settings.json'), '{"token":"боевой-токен"}\n');
  writeFileSync(join(dest, 'config/stations.json'), '{"пвз":"адрес"}\n');
  writeFileSync(join(dest, 'server/index.js'), 'старая версия\n');
  writeFileSync(join(dest, 'server/удалённый.js'), 'этого файла больше нет в репозитории\n');

  runBash(`sync_files "${src}" "${dest}"`);

  // Рабочие данные на месте.
  assert.match(readFileSync(join(dest, 'config/settings.json'), 'utf8'), /боевой-токен/);
  assert.match(readFileSync(join(dest, 'config/stations.json'), 'utf8'), /адрес/);
  assert.match(readFileSync(join(dest, '.env'), 'utf8'), /из-env/);
  // Код обновился, удалённый из репозитория файл убран.
  assert.match(readFileSync(join(dest, 'server/index.js'), 'utf8'), /новая версия/);
  assert.throws(() => readFileSync(join(dest, 'server/удалённый.js')), /ENOENT/);
});
