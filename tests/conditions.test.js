import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aqiFromConcentration, combinedAqi } from '../src/aqi.js';
import { alignWeather } from '../src/api.js';
import { conditionFlags, decideOutdoorPlan, hasAvoid, windowConditions, withConditions } from '../src/conditions.js';
import { evaluateSlot, findBestWindows, windowStats } from '../src/planner.js';

test('AQI giờ của O3 theo Bảng 2, QĐ 1459/QĐ-TCMT', () => {
  assert.equal(aqiFromConcentration(0, 'o3_1h'), 0);
  assert.equal(aqiFromConcentration(160, 'o3_1h'), 50);
  assert.equal(aqiFromConcentration(200, 'o3_1h'), 100);
  assert.equal(aqiFromConcentration(250, 'o3_1h'), 125);
  assert.equal(aqiFromConcentration(400, 'o3_1h'), 200);
  // VN_AQI là giá trị lớn nhất giữa các chất
  assert.equal(combinedAqi({ pm2_5: 20, pm10: 30, o3: 250 }), 125);
  assert.equal(combinedAqi({ pm2_5: 60, pm10: 30, o3: 80 }), aqiFromConcentration(60, 'pm2_5'));
  assert.equal(combinedAqi({ pm2_5: 20, pm10: 30 }), aqiFromConcentration(20, 'pm2_5'));
});

test('cảnh báo mưa, nóng, UV, ozone theo ngưỡng', () => {
  const ids = (c, pm = 0) => conditionFlags(c, pm).map((f) => `${f.id}:${f.severity}`);
  assert.deepEqual(ids({ rainProb: 70 }), ['rain:avoid']);
  assert.deepEqual(ids({ rainProb: 40 }), []);
  assert.deepEqual(ids({ feels: 36 }), ['heat:warn']);
  assert.deepEqual(ids({ feels: 41 }), ['heat:avoid']);
  assert.deepEqual(ids({ uv: 9 }), ['uv:warn']);
  assert.deepEqual(ids({ o3Aqi: 120 }), ['o3:avoid']);
  // Ozone 51–100 chỉ nhắc khi đang trội hơn bụi mịn
  assert.deepEqual(ids({ o3Aqi: 70 }, 40), ['o3:warn']);
  assert.deepEqual(ids({ o3Aqi: 70 }, 90), []);
  assert.deepEqual(ids({}), []);
});

test('ghép thời tiết đúng giờ, thiếu giờ thì để trống', () => {
  const times = ['2026-11-01T05:00', '2026-11-01T06:00', '2026-11-01T07:00'];
  const raw = { hourly: { time: ['2026-11-01T06:00', '2026-11-01T07:00'], precipitation_probability: [10, 80], apparent_temperature: [30, 31], uv_index: [0, 1], precipitation: [0, 2] } };
  const w = alignWeather(times, raw);
  assert.deepEqual(w.rainProb, [null, 10, 80]);
  assert.deepEqual(w.feels, [null, 30, 31]);
  assert.equal(alignWeather(times, null), null);
});

/** Một ngày: 00:00 ngày 2026-11-01, bây giờ là 05:00. */
function day(pm25, extra = {}) {
  const times = pm25.map((_, i) => `2026-11-01T${String(i).padStart(2, '0')}:00`);
  return { times, pm25, nowIndex: 5, ...extra };
}

test('khung gắn điều kiện: AQI lấy lớn nhất giữa bụi mịn và ozone', () => {
  const s = day(Array(24).fill(10), { o3: Array(24).fill(250), weather: { rainProb: Array(24).fill(0), feels: Array(24).fill(30), uv: Array(24).fill(3) } });
  const w = withConditions(s, windowStats(s.pm25, 8, 2));
  assert.equal(w.pmAqi, aqiFromConcentration(10, 'pm2_5'));
  assert.equal(w.aqi, 125);
  assert.deepEqual(w.flags.map((f) => f.id), ['o3']);
  assert.equal(windowConditions({ times: s.times, pm25: s.pm25 }, 8, 2).o3, null);
});

test('bỏ qua giờ dễ mưa, kể cả khi mọi giờ đều có cảnh báo', () => {
  const pm = Array(24).fill(40);
  pm[7] = 10; // giờ ít bụi nhất lại đang mưa
  pm[9] = 20;
  const rain = Array(24).fill(0);
  rain[7] = 90;
  const s = day(pm, { weather: { rainProb: rain } });
  const exclude = (w) => hasAvoid(withConditions(s, w).flags);
  const opts = { scope: 'today', ranges: [{ from: 5, to: 22 }], hours: 1, exclude };
  const r = findBestWindows(s, opts, 3);
  assert.equal(r.best[0].start, 9);
  assert.equal(r.excluded, 1);
  assert.equal(r.worst.mean, 40);

  const allRain = day(pm, { weather: { rainProb: Array(24).fill(90) } });
  const r2 = findBestWindows(allRain, { ...opts, exclude: (w) => hasAvoid(withConditions(allRain, w).flags) }, 3);
  assert.deepEqual(r2.best, []);
  assert.equal(r2.excluded, 17);
});

test('đánh giá ca học tính cả ozone', () => {
  const o3 = Array(24).fill(50);
  o3[11] = 320; // trưa nắng
  const s = day(Array(24).fill(15), { o3 });
  const slot = { from: '07:00', to: '12:00' };
  const v = evaluateSlot(s, '2026-11-01', slot, 'school');
  assert.ok(v.aqi >= 150, `aqi ${v.aqi}`);
});

test('giờ định đi có ozone cao thì chọn giờ phù hợp dù PM2.5 cao hơn', () => {
  const pm25 = Array(24).fill(30);
  const o3 = Array(24).fill(40);
  pm25[7] = 15;
  pm25[9] = 20;
  o3[7] = 320;
  const plan = decideOutdoorPlan(day(pm25, { o3 }), { scope: 'today', ranges: [{ from: 5, to: 10 }], hours: 1 }, 7);
  assert.equal(plan.outcome, 'switch');
  assert.equal(plan.mineBlocked, true);
  assert.equal(plan.top.start, 9);
  assert.equal(plan.cmp.relation, 'worse');
});

test('không đổi sang khung bụi cao khi tất cả lựa chọn đều có cảnh báo mức nên tránh', () => {
  const pm25 = Array(24).fill(150);
  const o3 = Array(24).fill(40);
  pm25[7] = 15;
  o3[7] = 320;
  const opts = { scope: 'today', ranges: [{ from: 5, to: 10 }], hours: 1 };
  const plan = decideOutdoorPlan(day(pm25, { o3 }), opts, 7);
  assert.equal(plan.outcome, 'none');
  assert.equal(plan.top, null);
  assert.deepEqual(plan.suggestions, []);
  assert.equal(decideOutdoorPlan(day(pm25, { o3 }), opts).outcome, 'none');
});

test('giữ lịch nếu giờ định đi phù hợp và chênh lệch bụi không đáng kể', () => {
  const pm25 = Array(24).fill(21);
  pm25[9] = 20;
  const plan = decideOutdoorPlan(day(pm25), { scope: 'today', ranges: [{ from: 5, to: 10 }], hours: 1 }, 7);
  assert.equal(plan.outcome, 'keep');
  assert.equal(plan.cmp.relation, 'same');
});
