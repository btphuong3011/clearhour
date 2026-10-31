import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectStations } from '../scripts/fetch-stations.mjs';
import { haversineKm, nearestStation } from '../src/stations.js';

const NOW = Date.parse('2026-10-31T08:30:00Z');

test('khoảng cách Hà Nội – TP.HCM khoảng 1.140 km', () => {
  const km = haversineKm(21.0285, 105.8542, 10.7769, 106.7009);
  assert.ok(km > 1130 && km < 1150, km);
});

test('chọn trạm gần nhất còn số đo mới, bỏ trạm quá xa hoặc số đo cũ', () => {
  const stations = [
    { name: 'Xa', lat: 21.6, lon: 105.85, pm25: 30, time: '2026-10-31T08:00:00Z' },
    { name: 'Cũ', lat: 21.03, lon: 105.85, pm25: 40, time: '2026-10-31T01:00:00Z' },
    { name: 'Gần', lat: 21.05, lon: 105.82, pm25: 22.4, time: '2026-10-31T08:00:00Z' },
    { name: 'Gần nhưng xa hơn', lat: 21.1, lon: 105.8, pm25: 25, time: '2026-10-31T08:00:00Z' },
  ];
  const st = nearestStation(stations, 21.0285, 105.8542, { now: NOW });
  assert.equal(st.name, 'Gần');
  assert.ok(st.km < 5);
  assert.equal(nearestStation(stations, 10.77, 106.7, { now: NOW }), null);
});

test('gom số đo PM2.5 mới nhất từ phản hồi OpenAQ v3', async () => {
  const responses = {
    locations: {
      results: [
        {
          id: 1,
          name: 'Hanoi US Embassy',
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
      ],
    },
    1: {
      results: [
        { sensorsId: 12, value: 40, datetime: { utc: '2026-10-31T08:00:00Z' } },
        { sensorsId: 11, value: 23.46, datetime: { utc: '2026-10-31T08:00:00Z' } },
      ],
    },
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
  // Trạm cũ không bị gọi API; trạm chỉ đo PM10 bị bỏ qua
  assert.equal(calls.filter((u) => u.includes('/latest')).length, 1);
});
