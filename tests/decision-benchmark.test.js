import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArchiveCsv } from '../scripts/accuracy.mjs';
import { scoreForecastArchive } from '../scripts/decision-benchmark.mjs';
import { localToUtc } from '../src/calendar.js';
import { addDays, formatClock } from '../src/time.js';

const firstDay = '2026-11-23';
const period = { firstDay, lastDay: firstDay };

function snapshot(day, hour = 4, minute = 0, weatherAvailable = true) {
  const time = Array.from({ length: 24 }, (_, i) => day + 'T' + formatClock(i));
  const pm25 = time.map((_, i) => i === 14 ? 12 : i === 17 ? 60 : 50);
  const air = {
    utc_offset_seconds: 25200, timezone: 'Asia/Bangkok',
    current: { time: time[4] }, hourly: { time, pm2_5: pm25 },
  };
  return {
    schema: 1,
    capturedAt: day + 'T' + formatClock(hour).slice(0, 2) + ':' + String(minute).padStart(2,'0') + ':00.000Z',
    cities: [{ id: 'hanoi' }],
    sources: {
      air: { data: [air] },
      weather: weatherAvailable ? { data: [{ hourly: { time, precipitation_probability: time.map(() => 0) } }] } : { error: 'HTTP 503' },
      correction: {},
    },
  };
}

const obs = (day, hour, value) => ({ t: +localToUtc(day + 'T' + formatClock(hour), 25200), value });

test('dùng bản lưu trước hạn, ghép đúng giờ Việt Nam và đợi đủ số ngày mới công bố tỷ lệ', () => {
  const newer = snapshot(firstDay, 4);
  newer.availableAt = firstDay + 'T04:00:10.000Z';
  newer.sources.air.data[0].hourly.pm2_5[14] = 100;
  const rows = scoreForecastArchive([newer, snapshot(firstDay)], [obs(firstDay, 17, 45), obs(firstDay, 14, 15)], period);
  assert.deepEqual(rows.map(({ hours, available }) => [hours, available]), [[6, 1], [12, 0], [24, 0]]);
  assert.equal(rows[0].meanLeadHours, 6);
  assert.deepEqual(rows[0].app, { switches: 1, better: 1, same: 0, worse: 0, scored: 1, days: 1, rate: null });
  assert.deepEqual(rows[0].raw, rows[0].app);
});

test('tách cửa sổ thiếu thời tiết, số đo thiếu, gần tương đương và đổi bất lợi', () => {
  const [unavailable] = scoreForecastArchive([snapshot(firstDay, 4, 0, false)], [], period);
  assert.equal(unavailable.available, 0);
  const [missing] = scoreForecastArchive([snapshot(firstDay)], [obs(firstDay, 17, 45)], period);
  assert.equal(missing.app.switches, 1);
  assert.equal(missing.app.scored, 0);
  const [same] = scoreForecastArchive([snapshot(firstDay)], [obs(firstDay, 17, 45), obs(firstDay, 14, 42)], period);
  assert.equal(same.app.same, 1);
  const [worse] = scoreForecastArchive([snapshot(firstDay)], [obs(firstDay, 17, 45), obs(firstDay, 14, 60)], period);
  assert.equal(worse.app.worse, 1);
});

test('công bố tỷ lệ sau ít nhất 20 lần đổi có số đo trên ít nhất 7 ngày', () => {
  const days = Array.from({ length: 20 }, (_, index) => addDays(firstDay, index));
  const snapshots = days.map((day) => snapshot(day));
  const observed = days.flatMap((day, index) => [obs(day, 17, 45), obs(day, 14, index < 15 ? 15 : 55)]);
  const [result] = scoreForecastArchive(snapshots, observed, { firstDay, lastDay: days.at(-1) });
  assert.equal(result.app.scored, 20);
  assert.equal(result.app.days, 20);
  assert.equal(result.app.rate, 0.75);
});

test('gom số đo 5 phút theo giờ kết thúc và loại giờ thiếu độ phủ', () => {
  const end = Date.UTC(2026, 10, 23, 1);
  const records = Array.from({ length: 12 }, (_, i) => [new Date(end - (11 - i) * 300_000).toISOString(), 20 + i]);
  records.push([new Date(end + 300_000).toISOString(), 30]);
  const csv = ['parameter,datetime,value', ...records.map(([time, value]) => ['pm25', time, value].join(','))].join('\n');
  assert.deepEqual(parseArchiveCsv(csv, { minSamplesPerHour: 9 }), [{ t: end - 3600_000, value: 25.5 }]);
});
