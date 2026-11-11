import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectStations } from '../scripts/fetch-stations.mjs';
import { ageText, haversineKm, nearestStation, toLocalTime } from '../src/stations.js';

const NOW = Date.parse('2026-10-31T08:30:00Z');

test('khoảng cách Hà Nội – TP.HCM khoảng 1.140 km', () => {
  const km = haversineKm(21.0285, 105.8542, 10.7769, 106.7009);
  assert.ok(km > 1130 && km < 1150, km);
});

test('chọn trạm gần nhất còn số đo mới, bỏ trạm quá xa hoặc số đo cũ', () => {
  const stations = [
    { name: 'Xa', lat: 21.6, lon: 105.85, pm25: 30, time: '2026-10-31T08:00:00Z' },
    { name: 'Cũ', lat: 21.03, lon: 105.85, pm25: 40, time: '2026-10-30T12:00:00Z' },
    { name: 'Gần', lat: 21.05, lon: 105.82, pm25: 22.4, time: '2026-10-31T08:00:00Z' },
    { name: 'Gần nhưng xa hơn', lat: 21.1, lon: 105.8, pm25: 25, time: '2026-10-31T08:00:00Z' },
  ];
  const st = nearestStation(stations, 21.0285, 105.8542, { now: NOW });
  assert.equal(st.name, 'Gần');
  assert.ok(st.km < 5);
  assert.equal(nearestStation(stations, 10.77, 106.7, { now: NOW }), null);
});

test('vẫn dùng số đo cũ vài giờ do lịch chạy GitHub Actions không đều', () => {
  const st = { name: 'ĐHBK', lat: 21.005, lon: 105.842, pm25: 12, time: '2026-10-31T01:50:00Z', isMonitor: true };
  assert.equal(nearestStation([st], 21.0285, 105.8542, { now: NOW }).name, 'ĐHBK'); // cũ 6 giờ 40 phút
  assert.equal(nearestStation([st], 21.0285, 105.8542, { now: NOW + 6 * 3600e3 }), null); // cũ hơn 12 giờ
});

test('giờ đo theo giờ địa phương và độ cũ dạng chữ', () => {
  assert.equal(toLocalTime('2026-10-31T08:50:00Z', 25200), '2026-10-31T15:50');
  assert.equal(toLocalTime('2026-10-31T20:00:00Z', 25200), '2026-11-01T03:00');
  assert.equal(ageText(2 * 60000), 'vừa cập nhật');
  assert.equal(ageText(25 * 60000), '25 phút trước');
  assert.equal(ageText(6.6 * 3600e3), '7 giờ trước');
});

test('ưu tiên trạm quan trắc chuẩn hơn cảm biến giá rẻ ở gần hơn', () => {
  const time = '2026-10-31T08:00:00Z';
  const sensor = { name: 'Cảm biến', lat: 21.03, lon: 105.855, pm25: 30, time, isMonitor: false };
  const monitor = { name: 'Trạm chuẩn', lat: 21.005, lon: 105.843, pm25: 12, time, isMonitor: true };
  assert.equal(nearestStation([sensor, monitor], 21.0285, 105.8542, { now: NOW }).name, 'Trạm chuẩn');
  assert.equal(nearestStation([monitor, sensor], 21.0285, 105.8542, { now: NOW }).name, 'Trạm chuẩn');
  assert.equal(nearestStation([sensor], 21.0285, 105.8542, { now: NOW }).name, 'Cảm biến');
});

test('gom số đo PM2.5 mới nhất từ phản hồi OpenAQ v3', async () => {
  const responses = {
    locations: {
      results: [
        {
          id: 1,
          name: 'Hanoi US Embassy ',
          country: { code: 'VN' },
          coordinates: { latitude: 21.02, longitude: 105.84 },
          isMonitor: true,
          provider: { name: 'AirNow' },
          sensors: [
            { id: 11, parameter: { id: 2, name: 'pm25' } },
            { id: 12, parameter: { id: 1, name: 'pm10' } },
          ],
          datetimeLast: { utc: '2026-10-31T08:00:00Z' },
        },
        {
          id: 2,
          name: 'Trạm ngừng hoạt động',
          coordinates: { latitude: 21, longitude: 105.8 },
          sensors: [{ id: 21, parameter: { id: 2, name: 'pm25' } }],
          datetimeLast: { utc: '2025-01-01T00:00:00Z' },
        },
        {
          id: 3,
          name: 'Chỉ đo PM10',
          coordinates: { latitude: 10.7, longitude: 106.7 },
          sensors: [{ id: 31, parameter: { id: 1, name: 'pm10' } }],
          datetimeLast: { utc: '2026-10-31T08:00:00Z' },
        },
        {
          id: 4,
          name: 'Pakse (Lào)',
          country: { code: 'LA' },
          coordinates: { latitude: 15.12, longitude: 105.8 },
          sensors: [{ id: 41, parameter: { id: 2, name: 'pm25' } }],
          datetimeLast: { utc: '2026-10-31T08:00:00Z' },
        },
        {
          id: 5,
          name: 'Cảm biến báo 0',
          country: { code: 'VN' },
          coordinates: { latitude: 10.78, longitude: 106.67 },
          sensors: [{ id: 51, parameter: { id: 2, name: 'pm25' } }],
          datetimeLast: { utc: '2026-10-31T08:00:00Z' },
        },
        {
          id: 6,
          name: 'PM2.5 ngừng từ tháng 5',
          country: { code: 'VN' },
          coordinates: { latitude: 16.05, longitude: 108.2 },
          sensors: [{ id: 61, parameter: { id: 2, name: 'pm25' } }],
          datetimeLast: { utc: '2026-10-31T08:00:00Z' },
        },
      ],
    },
    1: {
      results: [
        { sensorsId: 12, value: 40, datetime: { utc: '2026-10-31T08:00:00Z' } },
        { sensorsId: 11, value: 23.46, datetime: { utc: '2026-10-31T08:00:00Z' } },
      ],
    },
    5: { results: [{ sensorsId: 51, value: 0, datetime: { utc: '2026-10-31T08:00:00Z' } }] },
    6: { results: [{ sensorsId: 61, value: 14, datetime: { utc: '2026-05-21T16:00:00Z' } }] },
  };
  const calls = [];
  const getJson = async (url) => {
    calls.push(url);
    if (url.includes('/locations?')) return responses.locations;
    const id = url.match(/locations\/(\d+)\/latest/)[1];
    return responses[id];
  };
  const stations = await collectStations(getJson, { now: NOW });
  assert.deepEqual(stations, [
    {
      id: 1,
      name: 'Hanoi US Embassy',
      lat: 21.02,
      lon: 105.84,
      pm25: 23.5,
      time: '2026-10-31T08:00:00Z',
      isMonitor: true,
      provider: 'AirNow',
    },
  ]);
  // Trạm cũ, trạm nước ngoài và trạm chỉ đo PM10 không bị gọi API; số đo 0 và số đo cũ bị loại
  assert.deepEqual(
    calls.filter((u) => u.includes('/latest')).map((u) => u.match(/locations\/(\d+)/)[1]),
    ['1', '5', '6'],
  );
});
