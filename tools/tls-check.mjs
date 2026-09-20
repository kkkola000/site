// Проверка требования Яндекс Доставки: TLS 1.2+ и современные шифры.
// Запуск на сервере:  node /opt/anex-orders-src/tools/tls-check.mjs
import { connect } from 'node:tls';
import { DEFAULT_MIN_VERSION } from 'node:tls';

const host = process.argv[2] || 'b2b-authproxy.taxi.yandex.net';

console.log('Node.js:', process.version);
console.log('OpenSSL:', process.versions.openssl);
console.log('Минимальная версия TLS у процесса:', DEFAULT_MIN_VERSION);
console.log('Хост:', host);
console.log();

const socket = connect({ host, port: 443, servername: host, minVersion: 'TLSv1.2' }, () => {
  const cipher = socket.getCipher();
  const cert = socket.getPeerCertificate();

  console.log('Протокол:      ', socket.getProtocol());
  console.log('Шифр:          ', `${cipher.name} (${cipher.version})`);
  console.log('Сертификат:    ', cert.subject?.CN, '| до', cert.valid_to);
  console.log('Проверен:      ', socket.authorized ? 'да' : `нет — ${socket.authorizationError}`);

  const ok = ['TLSv1.2', 'TLSv1.3'].includes(socket.getProtocol());
  console.log('\nTLS 1.2+:', ok ? 'да, требование выполняется' : 'НЕТ');
  socket.end();
});

socket.on('error', (err) => {
  console.error('Не удалось соединиться:', err.message);
  process.exitCode = 1;
});
