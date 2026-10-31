import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aqiFromConcentration, combinedAqi, cigarettesPerDay, levelForAqi, levelForPm25, nowcast } from '../src/aqi.js';

test('PM2.5 khớp các mốc BPi của Bảng 2, QĐ 1459', () => {
  const cases = [
    [0, 0],
    [25, 50],
    [50, 100],
    [80, 150],
    [150, 200],
    [250, 300],
    [350, 400],
    [500, 500],
    [700, 500],
  ];
  for (const [c, expected] of cases) assert.equal(aqiFromConcentration(c, 'pm2_5'), expected, `PM2.5=${c}`);
});

test('nội suy tuyến tính giữa hai mốc', () => {
  assert.equal(aqiFromConcentration(17.4, 'pm2_5'), 35);
  assert.equal(aqiFromConcentration(37.5, 'pm2_5'), 75);
  assert.equal(aqiFromConcentration(100, 'pm10'), 75);
});

test('vượt ngưỡng 25 µg/m³ chuyển từ Tốt sang Trung bình', () => {
  assert.equal(levelForPm25(25).id, 'good');
  assert.equal(levelForPm25(25.6).id, 'moderate');
  assert.equal(levelForAqi(151).id, 'unhealthy');
  assert.equal(levelForAqi(301).id, 'hazardous');
});

test('Nowcast khớp ví dụ tính mẫu trong QĐ 1459 (≈ 20,3 µg/m³)', () => {
  // c1 là giờ hiện tại (20:00), c12 là 09:00
  const hours = [20.6, 19.6, 22.4, 20.3, 16.5, 19.0, 16.5, 19.5, 23.5, 20.5, 24.7, 26.9];
  assert.equal(Math.round(nowcast(hours) * 10) / 10, 20.3);
});

test('Nowcast dùng w = 0,5 khi số liệu biến động mạnh', () => {
  const v = nowcast([10, 100, 100]);
  // w = 0.5 → (10 + 50 + 25) / (1 + 0.5 + 0.25)
  assert.ok(Math.abs(v - 85 / 1.75) < 1e-9);
});

test('Nowcast trả về null khi thiếu số liệu gần nhất', () => {
  assert.equal(nowcast([null, null, 30, 30]), null);
});

test('VN_AQI tổng hợp lấy giá trị lớn nhất', () => {
  assert.equal(combinedAqi({ pm2_5: 30, pm10: 300 }), 175);
});

test('quy đổi điếu thuốc theo Berkeley Earth', () => {
  assert.equal(cigarettesPerDay(44), 2);
});
