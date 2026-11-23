import { t } from './i18n.js';
// Điều kiện khác ngoài bụi mịn trong một khung giờ: ozone (O3), mưa, nắng nóng và tia UV.
// Mục đích: không đề xuất một giờ "ít bụi" nhưng đang mưa to hay nóng gay gắt.
// Ngưỡng là giả định để cảnh báo cho dễ hiểu, không phải tiêu chuẩn y tế:
//  - Mưa: xác suất mưa từ 60% (Open-Meteo, precipitation_probability).
//  - Nóng: nhiệt độ cảm nhận từ 35°C là nóng, từ 40°C là nóng gay gắt (gần mức "nguy hiểm" của bảng Heat Index NOAA).
//  - UV: chỉ số từ 8 là "rất cao" theo thang của WHO.
//  - Ozone: VN_AQI giờ của O3 (QĐ 1459/QĐ-TCMT) trên 100 là kém; 51–100 chỉ nhắc khi ozone đang là chất trội hơn bụi mịn.

import { aqiFromConcentration, levelForAqi } from './aqi.js';
import { compareWithPlan, findBestWindows, windowStats } from './planner.js';

export const RAIN_PROB = 60;
export const FEELS_HOT = 35;
export const FEELS_VERY_HOT = 40;
export const UV_VERY_HIGH = 8;

const maxOf = (arr, start, slots) => {
  if (!arr) return null;
  let m = null;
  for (let k = 0; k < slots; k++) {
    const v = arr[start + k];
    if (v != null && (m == null || v > m)) m = v;
  }
  return m;
};

/** Giá trị lớn nhất trong khung (mưa, nhiệt độ cảm nhận, UV, O3). Thiếu dữ liệu thì để null. */
export function windowConditions(series, start, hours) {
  const slots = Math.ceil(hours);
  const w = series.weather ?? {};
  const o3 = maxOf(series.o3, start, slots);
  return {
    rainProb: maxOf(w.rainProb, start, slots),
    feels: maxOf(w.feels, start, slots),
    uv: maxOf(w.uv, start, slots),
    o3,
    o3Aqi: o3 == null ? null : aqiFromConcentration(o3, 'o3_1h'),
  };
}

/**
 * Các cảnh báo của khung, mỗi cảnh báo có mức 'avoid' (không nên đề xuất) hoặc 'warn' (chỉ nhắc).
 * pmAqi: AQI bụi mịn của khung, để biết ozone có đang là chất trội không.
 */
export function conditionFlags(c, pmAqi = 0) {
  const flags = [];
  if (c.rainProb != null && c.rainProb >= RAIN_PROB) {
    flags.push({ id: 'rain', severity: 'avoid', icon: '🌧️', label: t('Dễ mưa'), tip: t('Dễ có mưa, nhớ mang áo mưa hoặc chọn giờ khác.') });
  }
  if (c.feels != null && c.feels >= FEELS_VERY_HOT) {
    flags.push({ id: 'heat', severity: 'avoid', icon: '🥵', label: t('Nóng gay gắt'), tip: t('Trời nóng gay gắt, tránh vận động mạnh và uống đủ nước.') });
  } else if (c.feels != null && c.feels >= FEELS_HOT) {
    flags.push({ id: 'heat', severity: 'warn', icon: '🌡️', label: t('Trời nóng'), tip: t('Trời nóng, nhớ mang nước và nghỉ trong bóng râm.') });
  }
  if (c.uv != null && c.uv >= UV_VERY_HIGH) {
    flags.push({ id: 'uv', severity: 'warn', icon: '☀️', label: t('Tia UV rất cao'), tip: t('Nắng gắt, nên đội mũ, mặc áo dài tay, bôi kem chống nắng.') });
  }
  if (c.o3Aqi != null && c.o3Aqi > 100) {
    flags.push({ id: 'o3', severity: 'avoid', icon: '🟣', label: t('Ozone cao'), tip: t('Ozone cao (thường vào trưa nắng), nên giảm vận động mạnh ngoài trời.') });
  } else if (c.o3Aqi != null && c.o3Aqi > 50 && c.o3Aqi > pmAqi) {
    flags.push({ id: 'o3', severity: 'warn', icon: '🟣', label: t('Ozone hơi cao'), tip: t('Ozone hơi cao, người nhạy cảm nên giảm vận động mạnh.') });
  }
  return flags;
}

export const hasAvoid = (flags) => flags.some((f) => f.severity === 'avoid');

/** Chỉ so theo PM2.5 khi mọi khung đều bị loại riêng vì bụi. */
export function lowestDustWhenBlocked(windows) {
  if (!windows.length || !windows.every((window) => {
    const avoided = window.flags.filter((flag) => flag.severity === 'avoid');
    return avoided.length === 1 && avoided[0].id === 'pm25';
  })) return null;
  return windows.reduce((best, window) => window.mean < best.mean ||
    (window.mean === best.mean && window.start < best.start) ? window : best);
}

/**
 * Gắn điều kiện vào một khung đã tính bằng windowStats.
 * pmAqi giữ AQI của riêng bụi mịn; aqi thành giá trị lớn nhất giữa bụi mịn và ozone, đúng cách tính VN_AQI.
 */
export function withConditions(series, w) {
  if (!w) return w;
  const cond = windowConditions(series, w.start, w.hours);
  const pmAqi = w.pmAqi ?? w.aqi;
  return { ...w, pmAqi, aqi: Math.max(pmAqi, cond.o3Aqi ?? 0), cond, flags: conditionFlags(cond, pmAqi) };
}

/** Gắn cảnh báo cho một khung đi ngoài trời, kể cả khung được mở qua link chia sẻ. */
export function describeOutdoorWindow(series, window, sensitive = false) {
  if (!window) return null;
  const result = withConditions(series, window);
  if (result.pmAqi > (sensitive ? 100 : 150)) {
    const level = levelForAqi(result.pmAqi);
    result.flags.unshift({
      id: 'pm25', severity: 'avoid', icon: '◉', label: t('Bụi mịn cao'),
      tip: level.advice[sensitive ? 'sensitive' : 'normal'],
    });
  }
  return result;
}

/** Cùng một quy tắc chọn giờ cho phần so sánh và câu chuyện của Minh. */
export function decideOutdoorPlan(series, opts, planned = null) {
  const mine = planned == null ? null : describeOutdoorWindow(series, windowStats(series.pm25, planned, opts.hours, opts.ventilation), opts.sensitive);
  const mineBlocked = mine != null && hasAvoid(mine.flags);
  const descriptions = new Map();
  const found = findBestWindows(series, { ...opts, exclude: (window) => {
    const details = describeOutdoorWindow(series, window, opts.sensitive);
    descriptions.set(window.start, details);
    return window.start === mine?.start || hasAvoid(details.flags);
  } });
  const alternatives = found.best.map((window) => descriptions.get(window.start));
  const suggestions = mine && !mineBlocked
    ? alternatives.filter((window) => compareWithPlan(mine, window).relation !== 'worse')
    : alternatives;
  const top = suggestions[0] ?? null;
  const cmp = mine && top ? compareWithPlan(mine, top) : null;
  const windows = [...descriptions.values()];
  const blocked = windows.filter((window) => hasAvoid(window.flags));
  const worstSuitable = mine ? null : windows.reduce((worst, window) =>
    !hasAvoid(window.flags) && (!worst || window.mean > worst.mean) ? window : worst, null);
  if (mineBlocked && !descriptions.has(mine.start)) blocked.push(mine);
  const skipped = blocked.filter((window) => window.start !== mine?.start && top && window.mean < top.mean)
    .sort((a, b) => a.mean - b.mean || a.start - b.start)[0] ?? null;

  let outcome = 'unavailable';
  if (mine && !mineBlocked && cmp?.relation !== 'better') outcome = 'keep';
  else if (top) outcome = mine ? 'switch' : 'suggest';
  else if (blocked.length) outcome = 'none';

  return { mine, mineBlocked, suggestions, top, cmp, outcome, blocked, skipped, worstSuitable, hasAlternatives: alternatives.length > 0 };
}
