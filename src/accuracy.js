// Kết quả kiểm tra dự báo so với trạm đo (data/accuracy.json, do scripts/accuracy.mjs tạo)
// và hiệu chỉnh dự báo PM2.5 theo giờ trong ngày khi có trạm quan trắc chuẩn ở gần.

import { haversineKm } from './stations.js';
import { hourOf } from './time.js';

const ACCURACY_URL = './data/accuracy.json';

export async function fetchAccuracy() {
  try {
    const res = await fetch(ACCURACY_URL, { cache: 'no-cache' });
    if (!res.ok) return null;
    const doc = await res.json();
    return Array.isArray(doc.stations) && doc.stations.length ? doc : null;
  } catch {
    return null;
  }
}

/** Trạm đã kiểm tra gần nhất trong `maxKm`: ưu tiên trạm có hiệu chỉnh, rồi trạm quan trắc chuẩn, rồi trạm gần hơn. */
export function accuracyNear(doc, lat, lon, maxKm = 30) {
  const rank = (s) => (s.apply ? 2 : 0) + (s.isMonitor ? 1 : 0);
  let best = null;
  for (const s of doc?.stations ?? []) {
    if (!s.test) continue;
    const km = haversineKm(lat, lon, s.lat, s.lon);
    if (km > maxKm) continue;
    if (!best || rank(s) > rank(best) || (rank(s) === rank(best) && km < best.km)) best = { ...s, km };
  }
  return best;
}

/** Hệ số lưu theo giờ UTC; chuỗi dự báo dùng giờ địa phương. */
export function factorAt(factors, localTime, utcOffsetSeconds) {
  const shift = Math.round(utcOffsetSeconds / 3600);
  return factors[(((hourOf(localTime) - shift) % 24) + 24) % 24];
}

export function correctValues(times, values, factors, utcOffsetSeconds) {
  return values.map((v, i) => (v == null ? null : v * factorAt(factors, times[i], utcOffsetSeconds)));
}

/** Bản dự báo đã hiệu chỉnh; giữ lại bản gốc ở pm25Raw. Trạm không được bật hiệu chỉnh thì trả nguyên chuỗi. */
export function correctSeries(series, entry) {
  if (!entry?.apply || !entry.factors) return series;
  const pm25 = correctValues(series.times, series.pm25, entry.factors, series.utcOffsetSeconds);
  const nowFactor = factorAt(entry.factors, series.times[series.nowIndex], series.utcOffsetSeconds);
  return {
    ...series,
    pm25Raw: series.pm25,
    pm25,
    current: { ...series.current, pm25: series.current.pm25 == null ? null : series.current.pm25 * nowFactor },
    corrected: entry,
  };
}

/** Số ngày của đợt kiểm tra (1/3 thời gian sau). */
export const testDays = (test) => Math.max(1, Math.round((Date.parse(test.to) - Date.parse(test.from)) / 86400e3));
