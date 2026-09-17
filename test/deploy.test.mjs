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
