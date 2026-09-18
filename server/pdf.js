// Минимальный разбор PDF: нужен только размер страницы, чтобы понимать,
// какой ярлык на самом деле вернула Яндекс Доставка.
const PT_PER_MM = 72 / 25.4;

export function pageSizeMm(buffer) {
  if (!buffer || !buffer.length) return null;

  // MediaBox лежит в начале файла; ограничиваем просмотр, чтобы не читать
  // многомегабайтные ярлыки целиком.
  const head = buffer.subarray(0, Math.min(buffer.length, 256 * 1024)).toString('latin1');
  const match = head.match(/\/MediaBox\s*\[\s*([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s*\]/);
  if (!match) return null;

  const [x1, y1, x2, y2] = match.slice(1, 5).map(Number);
  if ([x1, y1, x2, y2].some((n) => !Number.isFinite(n))) return null;

  const width = Math.round(Math.abs(x2 - x1) / PT_PER_MM);
  const height = Math.round(Math.abs(y2 - y1) / PT_PER_MM);
  if (!width || !height) return null;

  return { width, height, label: `${width}x${height}` };
}

/** Совпадает ли страница с запрошенным размером (допуск ±2 мм на округление). */
export function matchesLabelSize(size, requested) {
  if (!size || !requested) return true;
  const [w, h] = requested.split('x').map(Number);
  if (!w || !h) return true;
  const close = (a, b) => Math.abs(a - b) <= 2;
  // Ярлык может быть повёрнут, поэтому сравниваем и в обратном порядке.
  return (close(size.width, w) && close(size.height, h)) || (close(size.width, h) && close(size.height, w));
}
