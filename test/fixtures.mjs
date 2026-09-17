// Пример ответа из документации метода 3.04 (requests/info), дополненный вторым заказом
// с доставкой до двери и возвратом — чтобы проверить обе ветки нормализации.
export const reportPickup = {
  request_id: '77241d8009bb46d0bff5c65a73077bcd-udp',
  request: {
    info: { operator_request_id: 'lKF4565ml', merchant_id: '290587090cfc', comment: 'Комментарий' },
    source: {
      platform_station: { platform_id: 'e1139f6d-e34f-47a9-a55f-31f032a861a6' },
      interval_utc: { from: '2026-09-16T06:00:00.000000Z', to: '2026-09-16T12:00:00.000000Z' },
    },
    destination: {
      type: 'platform_station',
      platform_station: { platform_id: '01946f4f013c7337874ec2fb848a58a4' },
      custom_location: null,
      interval_utc: { from: '2026-09-17T09:00:00.000000Z', to: '2026-09-17T18:00:00.000000Z' },
    },
    items: [
      {
        count: 1,
        name: 'Сумка ANEX для коляски Brown',
        article: 'AC/CB-02',
        billing_details: { unit_price: 2300000, assessed_unit_price: 2300000, nds: 20 },
        place_barcode: 'ANEX-01',
        photo_links: ['https://example.ru/anex-bag.jpg'],
        refused_count: 0,
      },
    ],
    places: [{ physical_dims: { weight_gross: 1200, dx: 40, dy: 30, dz: 20 }, barcode: 'ANEX-01' }],
    billing_info: { payment_method: 'already_paid', delivery_cost: 0 },
    recipient_info: { first_name: 'Василий', last_name: 'Пупкин', phone: '+79529999999' },
    last_mile_policy: 'self_pickup',
    available_actions: { update_dates_available: true },
  },
  state: {
    status: 'DELIVERY_TRANSPORTATION',
    description: 'Заказ в пути',
    timestamp: 1758067200,
    timestamp_utc: '2026-09-16T12:00:00.000000Z',
  },
  full_items_price: 2300000,
  sharing_url: 'https://dostavka.yandex.ru/route/ff60658e',
  courier_order_id: '786459112',
  self_pickup_node_code: { type: 'pickup', code: '00000' },
};

export const reportCourier = {
  request_id: 'aa11bb22cc33-udp',
  request: {
    info: { operator_request_id: '29991724-0648-1', comment: '' },
    source: { platform_station: { platform_id: 'e1139f6d-e34f-47a9-a55f-31f032a861a6' }, interval_utc: null },
    destination: {
      type: 'custom_location',
      platform_station: null,
      custom_location: {
        latitude: 55.76,
        longitude: 37.64,
        details: {
          locality: 'Реутов',
          street: 'Юбилейный проспект',
          house: '12',
          housing: '1',
          porch: '3',
          floor: '7',
          full_address: '',
        },
      },
      interval_utc: { from: '2026-09-17T07:00:00.000000Z', to: '2026-09-17T15:00:00.000000Z' },
    },
    items: [
      {
        count: 2,
        name: 'Коляска ANEX e/type',
        article: 'ET-01',
        billing_details: { unit_price: 12000000, assessed_unit_price: 12000000 },
        place_barcode: 'ANEX-02',
        refused_count: 1,
      },
    ],
    places: [{ physical_dims: { weight_gross: 15000, dx: 90, dy: 60, dz: 40 }, barcode: 'ANEX-02' }],
    billing_info: { payment_method: 'card_on_receipt', delivery_cost: 50000 },
    recipient_info: { first_name: 'Анна', last_name: 'Иванова', phone: '+79101112233' },
    last_mile_policy: 'time_interval',
  },
  state: {
    status: 'RETURNING',
    description: 'Заказ возвращается',
    timestamp: 1758153600,
    timestamp_utc: '2026-09-17T12:00:00.000000Z',
    reason: 'USER_CHANGED_MIND',
  },
  full_items_price: 24000000,
  courier_order_id: '',
  return_places: [{ physical_dims: { weight_gross: 15000, dx: 90, dy: 60, dz: 40 }, barcode: 'ANEX-02' }],
};
