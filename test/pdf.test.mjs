import test from 'node:test';
import assert from 'node:assert/strict';
import { pageSizeMm, matchesLabelSize } from '../server/pdf.js';

const pdf = (mediaBox) => Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Page/MediaBox [${mediaBox}]>>endobj\n`);

test('размер страницы читается из PDF и переводится в миллиметры', () => {
  // A4 — 595.28 × 841.89 пунктов.
  assert.deepEqual(pageSizeMm(pdf('0 0 595.28 841.89')).label, '210x297');
  // Этикетка 58 × 40 мм.
  assert.deepEqual(pageSizeMm(pdf('0 0 164.41 113.39')).label, '58x40');
});

test('ярлык не того размера виден сравнением', () => {
  const a4 = pageSizeMm(pdf('0 0 595.28 841.89'));
  const label = pageSizeMm(pdf('0 0 164.41 113.39'));

  assert.equal(matchesLabelSize(label, '58x40'), true);
  assert.equal(matchesLabelSize(a4, '58x40'), false);
  assert.equal(matchesLabelSize(a4, '210x297'), true);
  // Повёрнутая этикетка тоже считается совпадением.
  assert.equal(matchesLabelSize(pageSizeMm(pdf('0 0 113.39 164.41')), '58x40'), true);
});

test('неразобранный PDF не мешает печати', () => {
  // Если MediaBox не найден (сжатые объекты), проверка молча пропускается.
  assert.equal(pageSizeMm(Buffer.from('%PDF-1.7 без медиабокса')), null);
  assert.equal(pageSizeMm(Buffer.alloc(0)), null);
  assert.equal(matchesLabelSize(null, '58x40'), true);
});
