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
