// Nhìn lại khoảng 30 ngày qua bằng dữ liệu đã xảy ra (mô hình chạy lại, đã hiệu chỉnh theo trạm nếu có):
//  - Cá nhân: nếu mỗi ngày đều làm theo gợi ý đổi giờ thì hít ít bụi hơn bao nhiêu so với luôn đi giờ cũ.
//  - Trường học, doanh nghiệp: giờ nào trong ngày thường sạch, mỗi khung hoạt động có bao nhiêu ngày ổn.
// Đây là kết quả "biết trước", tức mức tốt nhất khi dự báo luôn đúng, không phải độ chính xác của dự báo.

import { aqiFromConcentration } from './aqi.js';
import { compareWithPlan, evaluateSlot, windowStats } from './planner.js';
import { datePart, hourOf } from './time.js';

const indexCache = new WeakMap();
function timeIndex(series) {
  let idx = indexCache.get(series.times);
  if (!idx) {
    idx = new Map(series.times.map((t, i) => [t, i]));
    indexCache.set(series.times, idx);
  }
  return idx;
}
const key = (day, hour) => `${day}T${String(hour).padStart(2, '0')}:00`;

/** Các ngày trọn vẹn trước `today`, lấy `limit` ngày gần nhất. */
export function pastDays(series, today, limit = 30) {
  return [...new Set(series.times.map(datePart))].filter((d) => d < today).slice(-limit);
}

/** VN_AQI của một giờ: lớn nhất giữa PM2.5 và O3. */
export function hourAqi(series, i) {
  const pm = series.pm25[i];
  if (pm == null) return null;
  const o3 = series.o3?.[i];
  return Math.max(aqiFromConcentration(pm, 'pm2_5'), o3 == null ? 0 : aqiFromConcentration(o3, 'o3_1h'));
}

/**
 * Mỗi ngày: khung ít bụi nhất trong lúc rảnh, và (nếu có giờ định đi) so với khung cùng giờ đó.
 * Đổi giờ chỉ khi ClearHour cũng sẽ gợi ý đổi (thấp hơn ít nhất 10% và 3 µg/m³).
 * Trả về { days, pct, worth, usualHour, usualCount } hoặc null khi không đủ dữ liệu.
 */
export function lookBack(series, { today, planHour = null, hours = 1, ranges, limit = 30 }) {
  const idx = timeIndex(series);
  let n = 0;
  let sumPlan = 0;
  let sumFollow = 0;
  let worth = 0;
  const bestAt = new Map();
  for (const d of pastDays(series, today, limit)) {
    let best = null;
    for (const r of ranges) {
      for (let h = r.from; h + hours <= r.to; h++) {
        const i = idx.get(key(d, h));
        const w = i == null ? null : windowStats(series.pm25, i, hours);
        if (w && (!best || w.mean < best.mean)) best = w;
      }
    }
    if (!best) continue;
    if (planHour != null) {
      const p = idx.get(key(d, planHour));
      const plan = p == null ? null : windowStats(series.pm25, p, hours);
      if (!plan) continue;
      const better = compareWithPlan(plan, best).relation === 'better';
      sumPlan += plan.mean;
      sumFollow += better ? best.mean : plan.mean;
      if (better) worth += 1;
    }
    n += 1;
    const h = hourOf(series.times[best.start]);
    bestAt.set(h, (bestAt.get(h) ?? 0) + 1);
  }
  if (!n) return null;
  const [usualHour, usualCount] = [...bestAt].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  return {
    days: n,
    pct: planHour == null || !sumPlan ? null : Math.max(0, Math.round(100 * (1 - sumFollow / sumPlan))),
    worth,
    usualHour,
    usualCount,
  };
}

/** Lưới ngày × giờ (VN_AQI từng giờ) để vẽ bản đồ "giờ thường sạch". */
export function cleanGrid(series, { today, fromHour = 5, toHour = 22, limit = 30 }) {
  const idx = timeIndex(series);
  const hours = Array.from({ length: toHour - fromHour }, (_, k) => fromHour + k);
  const rows = pastDays(series, today, limit).map((day) => ({
    day,
    cells: hours.map((h) => {
      const i = idx.get(key(day, h));
      return i == null ? null : hourAqi(series, i);
    }),
  }));
  return { hours, rows };
}

/**
 * Giờ (bắt đầu, kéo dài 1 giờ) trong [fromHour, toHour) có nhiều ngày ở mức Tốt hoặc Trung bình nhất (VN_AQI ≤ 100).
 * Bằng nhau thì lấy giờ có AQI trung bình thấp hơn.
 */
export function cleanestHour(grid, fromHour, toHour) {
  let best = null;
  grid.hours.forEach((h, k) => {
    if (h < fromHour || h >= toHour) return;
    const vals = grid.rows.map((r) => r.cells[k]).filter((v) => v != null);
    if (!vals.length) return;
    const clean = vals.filter((v) => v <= 100).length;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    if (!best || clean > best.clean || (clean === best.clean && mean < best.mean)) best = { hour: h, clean, days: vals.length, mean };
  });
  return best;
}

/** Số ngày mỗi khung hoạt động được đánh giá ổn / cần điều chỉnh / nên dừng trong những ngày qua. */
export function slotHistory(series, slot, orgType, { today, limit = 30 }) {
  const counts = { ok: 0, caution: 0, stop: 0 };
  let days = 0;
  for (const d of pastDays(series, today, limit)) {
    const v = evaluateSlot(series, d, slot, orgType);
    if (!v) continue;
    counts[v.status] += 1;
    days += 1;
  }
  return { days, counts };
}
