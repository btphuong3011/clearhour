import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateStation, fitFactors, orderAccuracy, pairUp, parseArchiveCsv, scores } from '../scripts/accuracy.mjs';
import { accuracyNear, correctSeries, factorAt } from '../src/accuracy.js';

const H = 3600e3;
const START = Date.parse('2026-09-20T00:00:00Z');

/** Số đo giả: mô hình luôn cao gấp đôi thực tế vào ban đêm (UTC 12–23), đúng vào ban ngày. */
function synthetic(days = 60) {
  const pairs = [];
  for (let i = 0; i < days * 24; i++) {
    const t = START + i * H;
    const h = new Date(t).getUTCHours();
    const obs = 20 + 15 * Math.sin((i / 24) * 2 * Math.PI) + (i % 7);
    pairs.push({ t, obs, model: h >= 12 ? obs * 2 : obs });
  }
  return pairs;
}

test('hệ số theo giờ học được độ lệch của mô hình', () => {
  const f = fitFactors(synthetic());
  assert.equal(f.length, 24);
  // Giữa ban đêm (UTC 18) mô hình cao gấp đôi -> hệ số gần 0,5; giữa ban ngày (UTC 6) gần 1
  // (hơi kéo về hệ số chung vì có làm co để tránh nhiễu khi ít mẫu)
  assert.ok(f[18] > 0.5 && f[18] < 0.6, `f18=${f[18]}`);
  assert.ok(f[6] > 0.9 && f[6] <= 1, `f6=${f[6]}`);
});

test('chấm điểm trên phần dữ liệu sau và chỉ bật hiệu chỉnh khi tốt hơn', () => {
  const r = evaluateStation(synthetic(), { isMonitor: true });
  assert.equal(r.apply, true);
  assert.ok(r.test.maeCorr < r.test.maeRaw * 0.5, JSON.stringify(r.test));
  assert.ok(r.test.levelCorr >= r.test.levelRaw);
  // Cảm biến giá rẻ: chỉ đối chiếu, không hiệu chỉnh
  const low = evaluateStation(synthetic(), { isMonitor: false });
  assert.equal(low.apply, false);
  assert.equal(low.reason, 'low-cost');
  // Mô hình đã đúng thì hiệu chỉnh không giúp gì
  const exact = synthetic().map((p) => ({ ...p, model: p.obs }));
  assert.equal(evaluateStation(exact).reason, 'no-gain');
  // Quá ít dữ liệu
  assert.equal(evaluateStation(synthetic(5)).reason, 'few-data');
});

test('độ đúng thứ tự giờ chỉ tính cặp chênh rõ, ban ngày giờ Việt Nam', () => {
  // 01:00 và 02:00 UTC = 8h và 9h sáng giờ Việt Nam
  const a = { t: Date.parse('2026-11-01T01:00:00Z'), obs: 10, model: 30 };
  const b = { t: Date.parse('2026-11-01T02:00:00Z'), obs: 30, model: 40 };
  const c = { t: Date.parse('2026-11-01T03:00:00Z'), obs: 31, model: 20 };
  const r = orderAccuracy([a, b, c]);
  // a<b đúng; a<c sai (mô hình xếp c thấp hơn a); b-c chênh 1 µg/m³ nên bỏ qua
  assert.equal(r.pairs, 2);
  assert.equal(r.rate, 0.5);
  assert.equal(scores([]).n, 0);
});

test('đọc CSV kho lưu trữ OpenAQ: chỉ PM2.5 hợp lệ, lùi về giờ bắt đầu, gộp nhiều cảm biến', () => {
  const csv = [
    '"location_id","sensors_id","location","datetime","lat","lon","parameter","units","value"',
    '1,11,"Trạm A, Hà Nội","2026-11-13T01:00:00+07:00","21","105","pm25","µg/m³","20"',
    '1,12,"Trạm A, Hà Nội","2026-11-13T01:00:00+07:00","21","105","pm25","µg/m³","30"',
    '1,13,"Trạm A, Hà Nội","2026-11-13T01:00:00+07:00","21","105","o3","µg/m³","90"',
    '1,11,"Trạm A, Hà Nội","2026-11-13T02:00:00+07:00","21","105","pm25","µg/m³","0"',
    '',
  ].join('\n');
  const obs = parseArchiveCsv(csv);
  assert.equal(obs.length, 1);
  assert.equal(obs[0].value, 25);
  assert.equal(new Date(obs[0].t).toISOString(), '2026-11-12T17:00:00.000Z');
  const pairs = pairUp(obs, { times: [obs[0].t], pm25: [40] });
  assert.deepEqual(pairs, [{ t: obs[0].t, obs: 25, model: 40 }]);
});

test('app: chọn trạm có hiệu chỉnh gần nhất và nhân hệ số theo giờ địa phương', () => {
  const factors = Array.from({ length: 24 }, (_, h) => (h === 0 ? 0.5 : 1));
  const doc = {
    stations: [
      { id: 1, lat: 21.0, lon: 105.8, isMonitor: false, apply: false, test: {}, factors },
      { id: 2, lat: 21.05, lon: 105.74, isMonitor: true, apply: true, test: {}, factors },
      { id: 3, lat: 10.8, lon: 106.7, isMonitor: true, apply: true, test: {}, factors },
    ],
  };
  assert.equal(accuracyNear(doc, 21.03, 105.85).id, 2);
  assert.equal(accuracyNear(doc, 16.05, 108.2), null);
  // 07:00 giờ Việt Nam (UTC+7) = 00:00 UTC
  assert.equal(factorAt(factors, '2026-11-01T07:00', 7 * 3600), 0.5);
  const series = { times: ['2026-11-01T06:00', '2026-11-01T07:00'], pm25: [40, 40], nowIndex: 1, utcOffsetSeconds: 25200, current: { pm25: 40 } };
  const fixed = correctSeries(series, doc.stations[1]);
  assert.deepEqual(fixed.pm25, [40, 20]);
  assert.deepEqual(fixed.pm25Raw, [40, 40]);
  assert.equal(fixed.current.pm25, 20);
  assert.equal(correctSeries(series, doc.stations[0]), series);
});
