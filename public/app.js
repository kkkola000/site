// Базовый путь панели: пусто при монтировании в корень домена,
// либо префикс вида /orders, если панель живёт внутри существующего сайта.
const BASE = (document.querySelector('meta[name="base-path"]')?.content || '').replace(/__BASE__/, '');
const api = (path) => `${BASE}${path}`;

const state = {
  tab: 'all',
  q: '',
  tabs: [],
  stages: [],
  orders: new Map(),
  counts: {},
  groups: [],
  loading: false,
};

const el = {
  tabs: document.getElementById('tabs'),
  list: document.getElementById('list'),
  skeleton: document.getElementById('skeleton'),
  search: document.getElementById('search'),
  clear: document.getElementById('search-clear'),
  refresh: document.getElementById('refresh'),
  banner: document.getElementById('banner'),
  updated: document.getElementById('updated'),
  settings: document.getElementById('settings'),
  drawer: document.getElementById('drawer'),
  drawerBody: document.getElementById('drawer-body'),
  drawerTitle: document.getElementById('drawer-title'),
};

const money = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const MONTHS = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function formatPrice(value, currency) {
  if (value === null || value === undefined) return '—';
  const sign = currency === 'RUB' ? ' ₽' : ` ${currency || ''}`;
  return money.format(value) + sign;
}

function formatDateHead(iso) {
  if (!iso || iso === 'unknown') return 'Дата не указана';
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return 'Дата не указана';
  const today = new Date();
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  const yesterday = new Date(today.getTime() - 864e5);
  if (sameDay(date, today)) return 'Сегодня';
  if (sameDay(date, yesterday)) return 'Вчера';
  return `${date.getDate()} ${MONTHS[date.getMonth()]}${date.getFullYear() === today.getFullYear() ? '' : ' ' + date.getFullYear()}`;
}

function formatDateTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

function formatShort(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date
    .toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    .replace('.,', ',');
}

function formatInterval(interval) {
  if (!interval || (!interval.from && !interval.to)) return '';
  const time = (iso) => (iso ? new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '');
  const day = interval.from ? new Date(interval.from).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) : '';
  const range = [time(interval.from), time(interval.to)].filter(Boolean).join('–');
  return [day, range].filter(Boolean).join(', ');
}

// ---------- Разделы ----------

function renderTabs() {
  el.tabs.innerHTML = state.tabs
    .map((tab) => {
      const count = state.counts[tab.id] ?? 0;
      const selected = tab.id === state.tab;
      return `<button class="tab" role="tab" aria-selected="${selected}" data-tab="${tab.id}">
        ${escapeHtml(tab.title)}${count ? `<span class="tab__count">${count}</span>` : ''}
      </button>`;
    })
    .join('');
}

// ---------- Карточка заказа в списке ----------

function itemRow(item) {
  return `<div class="item">
    <div class="item__name">${escapeHtml(item.name)}</div>
    <div class="item__count">${item.count} шт${item.refusedCount ? ` · отказ ${item.refusedCount}` : ''}</div>
  </div>`;
}

// Шкала этапов: цепочка фиксированной длины, пройденные этапы заливаются
// синим. Четвёртый этап подписывается «Возврат», если заказ поехал обратно.
function buildStages(order, history) {
  const stages = state.stages;
  if (!stages.length) return [];

  const passed = new Set((history || []).map((item) => item.stage));
  const isReturn = order.status.stage === 'return' || passed.has('return');
  const currentStage = order.status.stage === 'return' ? 'ready' : order.status.stage;
  const currentIndex = Math.max(0, stages.findIndex((stage) => stage.id === currentStage));

  // Время этапа — момент первого события, которое в него попало.
  const timeOf = (id) => {
    const wanted = id === 'ready' && isReturn ? ['ready', 'return'] : [id];
    const event = (history || []).find((item) => wanted.includes(item.stage));
    return event ? event.at : '';
  };

  // Заказ, закрытый не выдачей (отменён, возвращён), подписывается по факту.
  const finishedOtherwise = !['DELIVERY_DELIVERED', 'DELIVERY_TRANSMITTED_TO_RECIPIENT'].includes(order.status.code);

  return stages.map((stage, index) => {
    let title = stage.id === 'ready' && isReturn ? stage.returnTitle || stage.title : stage.title;
    if (stage.id === 'done' && index === currentIndex && finishedOtherwise) title = order.status.label;

    return {
      title,
      time: timeOf(stage.id),
      done: index < currentIndex,
      current: index === currentIndex,
      problem: index === currentIndex && order.status.problem,
    };
  });
}

function trackHtml(order, history) {
  const stages = buildStages(order, history);
  if (!stages.length) return '';

  const points = stages.map((stage) => {
    const classes = ['track__point'];
    if (stage.done) classes.push('is-done');
    if (stage.current) classes.push('is-current');
    if (stage.problem) classes.push('is-problem');

    return `<li class="${classes.join(' ')}">
      <span class="track__dot"></span>
      <span class="track__text">
        <span class="track__label">${escapeHtml(stage.title)}</span>
        ${stage.time ? `<span class="track__time">${escapeHtml(formatShort(stage.time))}</span>` : ''}
      </span>
    </li>`;
  });

  return `<ol class="track">${points.join('')}</ol>`;
}

function orderCard(order) {
  const badgeClass = order.status.problem ? 'problem' : order.status.group;

  const chips = [
    order.refusal === 'full' ? '<span class="chip chip--warn">Полный невыкуп</span>' : '',
    order.refusal === 'partial' ? '<span class="chip chip--warn">Частичный невыкуп</span>' : '',
    order.hasReturnPlaces ? '<span class="chip chip--warn">Возвратные грузоместа</span>' : '',
    order.paymentMethodLabel ? `<span class="chip">${escapeHtml(order.paymentMethodLabel)}</span>` : '',
    order.delivery.typeLabel ? `<span class="chip">${escapeHtml(order.delivery.typeLabel)}</span>` : '',
  ].filter(Boolean).join('');

  return `<article class="card" tabindex="0" data-id="${escapeHtml(order.id)}">
    <span class="badge badge--${badgeClass}">${escapeHtml(order.status.label)}</span>
    <div class="card__items">${order.items.map(itemRow).join('') || '<div class="item"><div class="item__name">Состав заказа не передан</div><div></div></div>'}</div>
    <div class="card__rows">
      <div class="row"><span class="row__label">Трек-номер</span><span class="row__value">${escapeHtml(order.trackNumber || '—')}</span></div>
    </div>
    ${chips ? `<div class="chips">${chips}</div>` : ''}
    <div class="card__foot">
      <div class="card__number">${escapeHtml(order.orderNumber)}</div>
      <div class="card__foot-right">
        <div class="card__price">${formatPrice(order.totalPrice, order.currency)}</div>
        <button class="btn btn--small btn--ghost" type="button" data-print="${escapeHtml(order.id)}">Печать</button>
      </div>
    </div>
    <div class="card__track" data-track="${escapeHtml(order.id)}"></div>
  </article>`;
}

function renderSetup() {
  el.list.innerHTML = `<div class="empty">
    <div class="empty__title">Панель ещё не подключена к Яндекс Доставке</div>
    <div>Укажите токен API — заказы появятся сразу после сохранения.</div>
    <div style="margin-top:16px"><button class="btn" type="button" data-open-settings>Открыть настройки</button></div>
  </div>`;
}

function renderList() {
  if (state.needsToken) {
    renderSetup();
    return;
  }
  if (!state.groups.length) {
    el.list.innerHTML = `<div class="empty">
      <div class="empty__title">Заказов нет</div>
      <div>${state.q ? 'Измените поисковый запрос' : 'В этом разделе пока пусто'}</div>
    </div>`;
    return;
  }

  el.list.innerHTML = state.groups
    .map(
      (group) => `<section>
        <h2 class="date-head">${escapeHtml(formatDateHead(group.date))}</h2>
        ${group.orders.map(orderCard).join('')}
      </section>`,
    )
    .join('');
}

// ---------- Загрузка ----------

// Историю запрашиваем по одному заказу и только когда карточка видна:
// иначе на каждое обновление списка пришлось бы дёргать API по числу заказов.
const historyCache = new Map();

const trackObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const node = entry.target;
      trackObserver.unobserve(node);
      fillTrack(node);
    }
  },
  { rootMargin: '200px' },
);

async function fillTrack(node) {
  const id = node.dataset.track;
  if (!id || node.dataset.filled) return;
  node.dataset.filled = '1';

  try {
    let history = historyCache.get(id);
    if (!history) {
      const response = await fetch(api(`/api/orders/${encodeURIComponent(id)}/history`));
      if (!response.ok) return;
      history = (await response.json()).history || [];
      historyCache.set(id, history);
    }
    const order = state.orders.get(id);
    if (order) node.innerHTML = trackHtml(order, history);
  } catch {
    // История — дополнение к карточке: без неё карточка остаётся рабочей.
  }
}

function observeTracks() {
  for (const node of el.list.querySelectorAll('[data-track]')) trackObserver.observe(node);
}

async function load({ force = false, showSkeleton = false } = {}) {
  if (showSkeleton) {
    el.skeleton.hidden = false;
    el.list.innerHTML = '';
  }
  state.loading = true;
  el.refresh.classList.toggle('is-busy', force);

  try {
    const params = new URLSearchParams({ tab: state.tab });
    if (state.q) params.set('q', state.q);
    if (force) params.set('refresh', '1');

    const response = await fetch(api(`/api/orders?${params}`));
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Ошибка ${response.status}`);

    state.tabs = data.tabs;
    state.stages = data.stages || [];
    state.counts = data.counts;
    state.groups = data.groups;
    state.orders = new Map(data.groups.flatMap((group) => group.orders).map((order) => [order.id, order]));
    state.needsToken = Boolean(data.needsToken);

    renderTabs();
    renderList();
    observeTracks();

    el.banner.hidden = !data.error;
    if (data.error) el.banner.textContent = `Данные могут быть неактуальны: ${data.error}`;
    el.updated.textContent = state.needsToken
      ? 'Токен API не задан'
      : `Обновлено: ${formatDateTime(data.updatedAt)} · заказов: ${data.total}`;
  } catch (err) {
    el.banner.hidden = false;
    el.banner.textContent = err.message;
    el.list.innerHTML = '';
  } finally {
    state.loading = false;
    el.skeleton.hidden = true;
    el.refresh.classList.remove('is-busy');
  }
}

// ---------- Карточка заказа (боковая панель) ----------

function detailPanels(order) {
  const rows = (items) =>
    items
      .filter(([, value]) => value)
      .map(([label, value]) => `<div class="row"><span class="row__label">${escapeHtml(label)}</span><span class="row__value">${value}</span></div>`)
      .join('');

  const history = (order.history || [])
    .map(
      (state_, index) => `<li${index === 0 ? ' class="timeline__current"' : ''}>
        <div>${escapeHtml(state_.description || state_.label)}</div>
        <div class="timeline__time">${escapeHtml(formatDateTime(state_.at))}${state_.reason ? ` · ${escapeHtml(state_.reason)}` : ''}</div>
      </li>`,
    )
    .join('');

  return `
    <div class="panel">
      <span class="badge badge--${order.status.problem ? 'problem' : order.status.group}">${escapeHtml(order.status.label)}</span>
      <div class="card__rows" style="margin-top:12px">
        ${rows([
          ['Статус', escapeHtml(order.status.description || order.status.label)],
          ['Причина', escapeHtml(order.status.reasonLabel || '')],
          ['Обновлён', escapeHtml(formatDateTime(order.status.at))],
          ['Трек-номер', escapeHtml(order.trackNumber || '')],
          ['ID заявки', escapeHtml(order.id)],
          ['Код получения', escapeHtml(order.selfPickupCode || '')],
        ])}
      </div>
      ${order.sharingUrl ? `<div style="margin-top:12px"><a class="btn btn--ghost" href="${escapeHtml(order.sharingUrl)}" target="_blank" rel="noopener">Трекинг для получателя</a></div>` : ''}
    </div>

    <div class="panel">
      <h3>Товары</h3>
      ${order.items
        .map(
          (item) => `<div class="row">
            <span class="row__label">${item.count} шт${item.refusedCount ? ` · отказ ${item.refusedCount}` : ''}</span>
            <span class="row__value">${escapeHtml(item.name)}${item.article ? `<div class="row__hint">${escapeHtml(item.article)}</div>` : ''}</span>
          </div>`,
        )
        .join('')}
      <div class="card__foot"><span class="card__number">Стоимость товаров</span><span class="card__price">${formatPrice(order.totalPrice, order.currency)}</span></div>
    </div>

    <div class="panel">
      <h3>Маршрут</h3>
      <div class="card__rows">
        ${rows([
          ['Отгрузка', escapeHtml(order.shipment.address || order.shipment.name || order.shipment.stationId || '—') + (order.shipment.interval ? `<div class="row__hint">${escapeHtml(formatInterval(order.shipment.interval))}</div>` : '')],
          ['Доставка', escapeHtml(order.delivery.address || order.delivery.name || '—') + (order.delivery.hints ? `<div class="row__hint">${escapeHtml(order.delivery.hints)}</div>` : '')],
          ['Способ', escapeHtml(order.delivery.typeLabel)],
          ['Интервал', escapeHtml(order.actual ? [order.actual.deliveryDate, order.actual.interval ? `${order.actual.interval.from}–${order.actual.interval.to}` : ''].filter(Boolean).join(', ') : formatInterval(order.delivery.interval))],
          ['Получатель', escapeHtml(order.recipient.name || '')],
          ['Телефон', escapeHtml(order.recipient.phone || '')],
          ['Оплата', escapeHtml(order.paymentMethodLabel || '')],
          ['Комментарий', escapeHtml(order.comment || '')],
        ])}
      </div>
    </div>

    <div class="panel">
      <h3>Ярлык</h3>
      <label class="field">
        <span class="field__label">Формат печати</span>
        <select class="field__input" id="label-size">
          ${(order.labelSizes || []).map((size) => `<option value="${escapeHtml(size.value)}"${size.value === order.labelSize ? ' selected' : ''}>${escapeHtml(size.title)}</option>`).join('')}
        </select>
      </label>
      <div class="field__hint">По умолчанию используется формат из настроек панели.</div>
      <div style="margin-top:12px"><button class="btn" type="button" id="print-label">Печать ярлыка</button></div>
    </div>

    ${order.places.length ? `<div class="panel">
      <h3>Грузоместа</h3>
      <div class="card__rows">
        ${order.places.map((place) => `<div class="row"><span class="row__label">${escapeHtml(place.barcode)}</span><span class="row__value">${place.weightGross ? `${(place.weightGross / 1000).toFixed(2)} кг` : ''} ${place.dims.some(Boolean) ? `· ${place.dims.join('×')} см` : ''}</span></div>`).join('')}
      </div>
    </div>` : ''}

    ${history ? `<div class="panel"><h3>История статусов</h3><ul class="timeline">${history}</ul></div>` : ''}
  `;
}

function settingsForm(data) {
  const status = data.tokenSet
    ? `<div class="chip">Токен задан: ${escapeHtml(data.tokenMask)}${data.tokenSource === 'env' ? ' (из .env)' : ''}</div>`
    : '<div class="chip chip--warn">Токен не задан</div>';

  return `<div class="panel">
    <h3>Подключение к Яндекс Доставке</h3>
    <div class="chips" style="margin:0 0 12px">${status}</div>
    <form id="settings-form">
      <label class="field">
        <span class="field__label">Токен API (Bearer)</span>
        <input class="field__input" type="password" name="token" autocomplete="off" spellcheck="false"
               placeholder="${data.tokenSet ? 'Оставьте пустым, чтобы не менять' : 'y2_...'}">
      </label>
      <label class="field">
        <span class="field__label">Формат ярлыка по умолчанию</span>
        <select class="field__input" name="labelSize">
          ${(data.labelSizes || []).map((size) => `<option value="${escapeHtml(size.value)}"${size.value === data.labelSize ? ' selected' : ''}>${escapeHtml(size.title)}</option>`).join('')}
        </select>
      </label>
      <label class="field">
        <span class="field__label">Раскладка ярлыков на странице</span>
        <select class="field__input" name="labelLayout">
          ${(data.labelLayouts || []).map((layout) => `<option value="${escapeHtml(layout.value)}"${layout.value === data.labelLayout ? ' selected' : ''}>${escapeHtml(layout.title)}</option>`).join('')}
        </select>
      </label>
      <label class="field">
        <span class="field__label">Склады отгрузки, через запятую (необязательно)</span>
        <input class="field__input" type="text" name="stationIds" autocomplete="off" spellcheck="false"
               value="${escapeHtml((data.stationIds || []).join(', '))}" placeholder="platform_station_id">
      </label>
      <div class="field__hint">
        Токен: личный кабинет Яндекс Доставки → Интеграция → «Получить токен».
        Хранится на сервере в файле с правами 600 и в браузер обратно не отдаётся.
      </div>
      <div style="margin-top:14px">
        <button class="btn" type="submit">Сохранить</button>
        <button class="btn btn--ghost" type="button" data-test-connection>Проверить связь</button>
        ${data.tokenSource === 'panel' ? '<button class="btn btn--danger" type="button" data-delete-token>Удалить токен</button>' : ''}
      </div>
      <div id="settings-result"></div>
    </form>
  </div>

  <div class="panel">
    <h3>Сервер</h3>
    <div class="card__rows">
      <div class="row"><span class="row__label">API</span><span class="row__value">${escapeHtml(data.apiBase)}${
        data.apiBaseIsProduction
          ? ''
          : `<div class="row__hint" style="color:var(--st-problem-fg)">Не боевой хост. Боевой: ${escapeHtml(data.productionApiBase)} — задаётся в YANDEX_API_BASE</div>`
      }</span></div>
      <div class="row"><span class="row__label">Метод ярлыка</span><span class="row__value">${escapeHtml(data.apiBase)}/api/b2b/platform/request/generate-labels</span></div>
      ${data.updatedAt ? `<div class="row"><span class="row__label">Изменено</span><span class="row__value">${escapeHtml(formatDateTime(data.updatedAt))}</span></div>` : ''}
    </div>
  </div>`;
}

async function openSettings() {
  el.drawer.hidden = false;
  el.drawerTitle.textContent = 'Настройки';
  el.drawerBody.innerHTML = '<div class="skeleton-card"></div>';
  document.body.style.overflow = 'hidden';

  const data = await (await fetch(api('/api/settings'))).json();
  el.drawerBody.innerHTML = settingsForm(data);

  const form = document.getElementById('settings-form');
  const result = document.getElementById('settings-result');
  const say = (ok, text) => {
    result.innerHTML = `<div class="banner" style="${ok ? 'background:#e3f7ec;color:#1a7f4b' : ''}">${escapeHtml(text)}</div>`;
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const token = form.token.value.trim();
    const payload = {
      stationIds: form.stationIds.value,
      labelSize: form.labelSize.value,
      labelLayout: form.labelLayout.value,
    };
    // Пустое поле означает «не менять», а не «стереть токен».
    if (token) payload.token = token;

    const response = await fetch(api('/api/settings'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      say(false, 'Не удалось сохранить настройки');
      return;
    }
    form.token.value = '';
    say(true, 'Сохранено');
    load({ force: true });
  });

  const removeButton = form.querySelector('[data-delete-token]');
  if (removeButton) {
    removeButton.addEventListener('click', async () => {
      if (!confirm('Удалить токен? Панель перестанет получать заказы, пока не будет введён новый.')) return;

      const response = await fetch(api('/api/settings'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Пустая строка — это осознанное удаление, в отличие от пустого поля формы.
        body: JSON.stringify({ token: '' }),
      });
      if (!response.ok) {
        say(false, 'Не удалось удалить токен');
        return;
      }
      const data_ = await response.json();
      // Если токен остался в .env сервера, панель продолжит работать на нём.
      say(true, data_.tokenSet ? 'Токен панели удалён, используется токен из .env сервера' : 'Токен удалён');
      await openSettings();
      load({ force: true });
    });
  }

  form.querySelector('[data-test-connection]').addEventListener('click', async () => {
    say(true, 'Проверяю…');
    const response = await fetch(api('/api/settings/test'), { method: 'POST' });
    const data_ = await response.json();
    say(data_.ok, data_.message);
  });
}

function printLabel(id, size) {
  const params = size ? `?size=${encodeURIComponent(size)}` : '';
  window.open(api(`/api/orders/${encodeURIComponent(id)}/label${params}`), '_blank', 'noopener');
}

async function openOrder(id) {
  el.drawer.hidden = false;
  el.drawerTitle.textContent = 'Заказ';
  el.drawerBody.innerHTML = '<div class="skeleton-card"></div><div class="skeleton-card"></div>';
  document.body.style.overflow = 'hidden';

  try {
    const response = await fetch(api(`/api/orders/${encodeURIComponent(id)}`));
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Ошибка ${response.status}`);
    // Формат печати берём из настроек панели, но в карточке его можно поменять.
    const settings = await (await fetch(api('/api/settings'))).json().catch(() => ({}));
    el.drawerTitle.textContent = data.order.orderNumber;
    el.drawerBody.innerHTML = detailPanels({
      ...data.order,
      labelSize: settings.labelSize,
      labelSizes: settings.labelSizes || [],
    });

    const printButton = document.getElementById('print-label');
    if (printButton) {
      printButton.addEventListener('click', () => printLabel(id, document.getElementById('label-size').value));
    }
  } catch (err) {
    el.drawerBody.innerHTML = `<div class="banner">${escapeHtml(err.message)}</div>`;
  }
}

function closeDrawer() {
  el.drawer.hidden = true;
  document.body.style.overflow = '';
  if (location.hash === '#settings') history.replaceState(null, '', location.pathname + location.search);
}

// ---------- События ----------

el.tabs.addEventListener('click', (event) => {
  const button = event.target.closest('[data-tab]');
  if (!button) return;
  state.tab = button.dataset.tab;
  renderTabs();
  // Прямая ссылка на настройки: /#settings
if (location.hash === '#settings') openSettings();

load({ showSkeleton: true });
});

let searchTimer;
el.search.addEventListener('input', () => {
  el.clear.hidden = !el.search.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = el.search.value.trim();
    load();
  }, 250);
});

el.clear.addEventListener('click', () => {
  el.search.value = '';
  el.clear.hidden = true;
  state.q = '';
  load();
  el.search.focus();
});

el.refresh.addEventListener('click', () => load({ force: true }));

el.settings.addEventListener('click', openSettings);

el.list.addEventListener('click', (event) => {
  if (event.target.closest('[data-open-settings]')) {
    openSettings();
    return;
  }

  const print = event.target.closest('[data-print]');
  if (print) {
    // Клик по кнопке печати не должен открывать карточку заказа.
    event.stopPropagation();
    printLabel(print.dataset.print);
    return;
  }

  const card = event.target.closest('[data-id]');
  if (card) openOrder(card.dataset.id);
});

el.list.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const card = event.target.closest('[data-id]');
  if (!card) return;
  event.preventDefault();
  openOrder(card.dataset.id);
});

el.drawer.addEventListener('click', (event) => {
  if (event.target.closest('[data-close]')) closeDrawer();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !el.drawer.hidden) closeDrawer();
  if (event.key === '/' && document.activeElement !== el.search) {
    event.preventDefault();
    el.search.focus();
  }
});

// Фоновое обновление списка, пока вкладка открыта.
setInterval(() => {
  if (!state.loading && el.drawer.hidden && document.visibilityState === 'visible') load();
}, 60000);

// Прямая ссылка на настройки: /#settings
if (location.hash === '#settings') openSettings();

load({ showSkeleton: true });
