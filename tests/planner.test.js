import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalize } from '../src/api.js';
import {
  candidateStarts,
  compareWithPlan,
  dailyMean,
  evaluateSlot,
  findBestWindows,
  reductionPct,
  ventilationPlan,
  ventStatus,
  windowStats,
} from '../src/planner.js';

/** Chuỗi 3 ngày giả lập, bắt đầu 00:00 ngày 2026-11-01, "bây giờ" là 06:00. */
function makeSeries(values, nowIndex = 6) {
  const times = values.map((_, i) => {
    const d = 1 + Math.floor(i / 24);
    return `2026-11-${String(d).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00`;
  });
  return { times, pm25: values, nowIndex };
}

const dayShape = [50, 52, 55, 58, 56, 54, 55, 40, 28, 19, 16, 15, 17, 18, 17, 16, 17, 17, 20, 20, 23, 27, 31, 35];
const series = makeSeries([...dayShape, ...dayShape.map((v) => v + 5), ...dayShape.map((v) => v + 10)]);

test('thống kê khung giờ tính đúng trung bình, liều hít vào và giờ lẻ', () => {
  const pm = [10, 20, 30, 40];
  assert.deepEqual(
    { mean: windowStats(pm, 1, 2, 2).mean, dose: windowStats(pm, 1, 2, 2).dose },
    { mean: 25, dose: 100 },
  );
  const half = windowStats(pm, 0, 0.5, 1);
  assert.equal(half.mean, 10);
  assert.equal(half.dose, 5);
  assert.equal(windowStats(pm, 3, 2, 1), null);
});

test('chỉ xét giờ từ hiện tại trở đi và trong khung giờ cho phép', () => {
  const starts = candidateStarts(series, { scope: 'today', fromHour: 5, toHour: 22, hours: 1 });
  assert.equal(starts[0], 6);
  assert.equal(starts[starts.length - 1], 21);
  const tomorrow = candidateStarts(series, { scope: 'tomorrow', fromHour: 5, toHour: 22, hours: 2 });
  assert.equal(tomorrow[0], 24 + 5);
  assert.equal(tomorrow[tomorrow.length - 1], 24 + 20);
});

test('khung tốt nhất rơi vào buổi trưa, các gợi ý cách nhau ít nhất 2 giờ', () => {
  const { best, worst } = findBestWindows(series, { scope: 'today', fromHour: 5, toHour: 22, hours: 1 }, 3);
  assert.deepEqual(
    best.map((b) => b.start),
    [11, 15, 18],
  ); // 15, 16 và 20 µg/m³
  assert.equal(worst.start, 6); // 55 µg/m³ lúc 06:00
  assert.equal(reductionPct(best[0].mean, worst.mean), 73);

  const twoHours = findBestWindows(series, { scope: 'today', fromHour: 5, toHour: 22, hours: 2 }, 3).best;
  for (let i = 0; i < twoHours.length; i++)
    for (let j = i + 1; j < twoHours.length; j++)
      assert.ok(Math.abs(twoHours[i].start - twoHours[j].start) >= 4);
});

test('trung bình ngày và đánh giá khung hoạt động của trường học', () => {
  assert.ok(Math.abs(dailyMean(series, '2026-11-01') - dayShape.reduce((a, b) => a + b) / 24) < 1e-9);
  const morning = evaluateSlot(series, '2026-11-01', { from: '07:00', to: '07:45' }, 'school');
  assert.equal(morning.peak, 40);
  assert.equal(morning.level.id, 'moderate');
  assert.equal(morning.status, 'ok');
  const early = evaluateSlot(series, '2026-11-03', { from: '03:00', to: '04:00' }, 'school');
  assert.equal(early.level.id, 'poor');
  assert.equal(early.status, 'caution');
});

test('chuẩn hóa dữ liệu mẫu Open-Meteo và xác định giờ hiện tại', () => {
  const raw = JSON.parse(readFileSync(new URL('../data/sample-hanoi.json', import.meta.url)));
  const s = normalize(raw, 'sample');
  assert.equal(s.times[s.nowIndex].slice(0, 13), raw.current.time.slice(0, 13));
  assert.equal(s.pm25.length, s.times.length);
});

test('trạng thái cửa sổ theo ngưỡng 25 và 50 µg/m³', () => {
  assert.equal(ventStatus(25).id, 'open');
  assert.equal(ventStatus(25.1).id, 'brief');
  assert.equal(ventStatus(50).id, 'brief');
  assert.equal(ventStatus(50.1).id, 'closed');
});

test('kế hoạch mở cửa sổ 24 giờ: gom các giờ liên tiếp và chọn giờ thông gió tốt nhất', () => {
  const plan = ventilationPlan(series, 24);
  assert.equal(plan.slots.length, 24);
  assert.deepEqual(
    plan.runs.map((r) => [r.status.id, r.start, r.end]),
    [
      ['closed', 6, 7],
      ['brief', 7, 9],
      ['open', 9, 21],
      ['brief', 21, 24],
      ['closed', 24, 30],
    ],
  );
  assert.deepEqual(
    plan.best.map((w) => w.start),
    [11, 15],
  );
});

test('chỉ xét các khoảng rảnh rời nhau, ví dụ trước và sau giờ làm', () => {
  const ranges = [
    { from: 5, to: 7 },
    { from: 17, to: 21 },
  ];
  const starts = candidateStarts(series, { scope: 'tomorrow', ranges, hours: 1 });
  assert.deepEqual(
    starts.map((i) => i - 24),
    [5, 6, 17, 18, 19, 20],
  );
  // Khung 2 giờ phải nằm trọn trong một khoảng rảnh
  assert.deepEqual(
    candidateStarts(series, { scope: 'tomorrow', ranges, hours: 2 }).map((i) => i - 24),
    [5, 17, 18, 19],
  );
  const { best } = findBestWindows(series, { scope: 'tomorrow', ranges, hours: 1 }, 3);
  assert.equal(best[0].start, 24 + 17); // 22 µg/m³, thấp nhất trong các giờ rảnh
});

test('so với giờ định đi: chỉ khuyên đổi khi chênh lệch đủ lớn', () => {
  const at = (mean, start) => ({ mean, start });
  assert.deepEqual(compareWithPlan(at(40, 7), at(27, 16)), { relation: 'better', pct: 33, diff: -13 });
  assert.equal(compareWithPlan(at(40, 7), at(55, 6)).relation, 'worse');
  assert.equal(compareWithPlan(at(40, 7), at(37, 16)).relation, 'same'); // chênh 7,5% < 10%
  assert.equal(compareWithPlan(at(12, 7), at(10, 16)).relation, 'same'); // chênh 2 µg/m³ < 3
  assert.equal(compareWithPlan(at(40, 7), at(20, 7)).relation, 'same'); // cùng một khung
});

test('đánh giá khung cố định trả về cả mức đỉnh và trung bình', () => {
  const shift = evaluateSlot(series, '2026-11-01', { from: '07:00', to: '11:00' }, 'business');
  assert.equal(shift.peak, 40);
  assert.equal(shift.mean, (40 + 28 + 19 + 16) / 4);
});
