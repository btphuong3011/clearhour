import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanGrid, cleanestHour, hourAqi, lookBack, pastDays, slotHistory } from '../src/history.js';

/** `days` ngày bắt đầu 2026-10-01, mỗi ngày dùng cùng hình dạng `shape` (24 giá trị), cộng thêm `bump(day)`. */
function history(days, shape, bump = () => 0) {
  const times = [];
  const pm25 = [];
  for (let d = 0; d < days; d++) {
    const date = new Date(Date.UTC(2026, 9, 1 + d)).toISOString().slice(0, 10);
    for (let h = 0; h < 24; h++) {
      times.push(`${date}T${String(h).padStart(2, '0')}:00`);
      pm25.push(shape[h] + bump(d));
    }
  }
  return { times, pm25, o3: null };
}

// Sáng sớm nhiều bụi, chiều ít bụi
const shape = [50, 50, 50, 50, 50, 60, 60, 60, 40, 30, 25, 20, 18, 16, 15, 15, 16, 20, 30, 40, 45, 50, 50, 50];

test('chỉ lấy các ngày trọn vẹn trước hôm nay', () => {
  const h = history(35, shape);
  const days = pastDays(h, '2026-11-04', 30);
  assert.equal(days.length, 30);
  assert.equal(days.at(-1), '2026-11-03');
  assert.equal(days[0], '2026-10-05');
});

test('nhìn lại: luôn đi 6h sáng thì đổi sang chiều giảm được nhiều', () => {
  const h = history(31, shape);
  const r = lookBack(h, { today: '2026-11-01', planHour: 6, hours: 1, ranges: [{ from: 5, to: 7 }, { from: 14, to: 18 }] });
  assert.equal(r.days, 30);
  assert.equal(r.worth, 30);
  assert.equal(r.usualHour, 14);
  assert.equal(r.pct, 75); // 60 -> 15
});

test('nhìn lại: giờ định đi đã là lúc ít bụi thì không cần đổi', () => {
  const h = history(31, shape);
  const r = lookBack(h, { today: '2026-11-01', planHour: 14, hours: 1, ranges: [{ from: 5, to: 22 }] });
  assert.equal(r.worth, 0);
  assert.equal(r.pct, 0);
  const free = lookBack(h, { today: '2026-11-01', hours: 1, ranges: [{ from: 5, to: 9 }] });
  assert.equal(free.pct, null);
  assert.equal(free.usualHour, 8);
  assert.equal(lookBack({ times: [], pm25: [] }, { today: '2026-11-01', hours: 1, ranges: [{ from: 5, to: 9 }] }), null);
});

test('bản đồ giờ sạch và giờ thường sạch nhất trong giờ học', () => {
  // 10 ngày đầu bụi cao hơn hẳn
  const h = history(31, shape, (d) => (d < 10 ? 40 : 0));
  const grid = cleanGrid(h, { today: '2026-11-01', fromHour: 5, toHour: 22 });
  assert.equal(grid.hours.length, 17);
  assert.equal(grid.rows.length, 30);
  assert.equal(grid.rows[0].cells.length, 17);
  const best = cleanestHour(grid, 7, 17);
  assert.equal(best.hour, 14);
  assert.equal(best.days, 30);
});

test('AQI theo giờ tính cả ozone; số ngày ổn của từng khung', () => {
  const h = history(31, shape);
  h.o3 = h.times.map((t) => (t.endsWith('T12:00') ? 320 : 40));
  assert.ok(hourAqi(h, h.times.indexOf('2026-10-02T12:00')) >= 150);
  const r = slotHistory(h, { from: '12:00', to: '13:00' }, 'school', { today: '2026-11-01' });
  assert.equal(r.days, 30);
  assert.equal(r.counts.stop, 30);
  const morning = slotHistory(h, { from: '15:00', to: '16:00' }, 'school', { today: '2026-11-01' });
  assert.equal(morning.counts.ok, 30);
});
