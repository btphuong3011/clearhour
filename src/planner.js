import { aqiFromConcentration, levelForAqi } from './aqi.js';
import { addDays, datePart, hourOf, parseClock } from './time.js';

export const PROFILES = [
  { id: 'adult', label: 'Người trưởng thành khỏe mạnh', short: 'Người khỏe mạnh', icon: '🧑', sensitive: false },
  { id: 'child', label: 'Trẻ em', short: 'Trẻ em', icon: '🧒', sensitive: true },
  { id: 'elderly', label: 'Người cao tuổi', short: 'Người cao tuổi', icon: '🧓', sensitive: true },
  { id: 'respiratory', label: 'Có bệnh hô hấp / tim mạch', short: 'Bệnh hô hấp, tim mạch', icon: '🫁', sensitive: true },
  { id: 'pregnant', label: 'Phụ nữ mang thai', short: 'Phụ nữ mang thai', icon: '🤰', sensitive: true },
];

// Mức thông khí (m³ không khí hít vào mỗi giờ) theo cường độ hoạt động của người trưởng thành,
// làm tròn từ US EPA Exposure Factors Handbook (2011), chương 6.
export const ACTIVITIES = [
  { id: 'run', label: 'Chạy bộ, đá bóng, tập thể dục', short: 'Chạy bộ / thể thao', icon: '🏃', intensity: 'mạnh', ventilation: 3.0 },
  { id: 'cycle', label: 'Đạp xe', short: 'Đạp xe', icon: '🚲', intensity: 'vừa', ventilation: 1.6 },
  { id: 'walk', label: 'Đi bộ, đưa đón con', short: 'Đi bộ / đưa đón con', icon: '🚶', intensity: 'nhẹ–vừa', ventilation: 1.0 },
  { id: 'moto', label: 'Di chuyển bằng xe máy', short: 'Đi xe máy', icon: '🛵', intensity: 'nhẹ', ventilation: 0.7 },
  { id: 'work', label: 'Làm việc ngoài trời (giao hàng, xây dựng…)', short: 'Làm việc ngoài trời', icon: '📦', intensity: 'vừa', ventilation: 1.6 },
];

export const DURATIONS = [0.5, 1, 2, 4, 8];

/**
 * Thống kê một khung thời gian bắt đầu tại chỉ số `start`, kéo dài `hours` giờ.
 * Giờ cuối có thể chỉ được tính một phần (ví dụ 30 phút).
 */
export function windowStats(pm25, start, hours, ventilation = 1) {
  const slots = Math.ceil(hours);
  if (start < 0 || start + slots > pm25.length) return null;
  let weighted = 0;
  let weight = 0;
  let peak = -Infinity;
  for (let k = 0; k < slots; k++) {
    const c = pm25[start + k];
    if (c == null) return null;
    const w = Math.min(1, hours - k);
    weighted += c * w;
    weight += w;
    peak = Math.max(peak, c);
  }
  const mean = weighted / weight;
  return {
    start,
    hours,
    mean,
    peak,
    // µg PM2.5 đi vào phổi ≈ nồng độ (µg/m³) × thông khí (m³/h) × thời gian (h)
    dose: weighted * ventilation,
    aqi: aqiFromConcentration(mean, 'pm2_5'),
  };
}

/**
 * Các giờ bắt đầu hợp lệ: từ giờ hiện tại trở đi, nằm trọn trong một khoảng rảnh của cùng một ngày.
 * scope: 'today' | 'tomorrow' | 'all' (3 ngày) | 'next24' (24 giờ tới).
 * ranges: các khoảng rảnh [{ from, to }] theo giờ trong ngày, có thể rời nhau (ví dụ 5–7 và 17–21).
 */
export function candidateStarts(series, { scope = 'today', fromHour = 5, toHour = 22, ranges, hours = 1 }) {
  const free = ranges?.length ? ranges : [{ from: fromHour, to: toHour }];
  const { times, nowIndex } = series;
  const today = datePart(times[nowIndex]);
  const days =
    scope === 'today' ? [today] : scope === 'tomorrow' ? [addDays(today, 1)] : [today, addDays(today, 1), addDays(today, 2)];
  const inScope = scope === 'next24' ? (i) => i < nowIndex + 24 : (i) => days.includes(datePart(times[i]));
  const out = [];
  for (let i = nowIndex; i < times.length; i++) {
    if (!inScope(i)) continue;
    const h = hourOf(times[i]);
    if (!free.some((r) => h >= r.from && h + hours <= r.to)) continue;
    if (i + Math.ceil(hours) > times.length) continue;
    out.push(i);
  }
  return out;
}

/**
 * Tìm `count` khung giờ có nồng độ PM2.5 trung bình thấp nhất, kèm khung tệ nhất để so sánh.
 * Các khung gợi ý cách nhau ít nhất 2 giờ để người dùng có những lựa chọn thật sự khác nhau.
 */
export function findBestWindows(series, opts, count = 3) {
  const ventilation = opts.ventilation ?? 1;
  const all = candidateStarts(series, opts)
    .map((i) => windowStats(series.pm25, i, opts.hours, ventilation))
    .filter(Boolean);
  if (!all.length) return { best: [], worst: null, all };

  const sorted = [...all].sort((a, b) => a.mean - b.mean || a.start - b.start);
  const gap = Math.ceil(opts.hours) + 2;
  const best = [];
  for (const w of sorted) {
    if (best.every((b) => Math.abs(w.start - b.start) >= gap)) best.push(w);
    if (best.length === count) break;
  }
  const worst = sorted[sorted.length - 1];
  return { best, worst, all };
}

// Hai khung chênh nhau dưới 10% hoặc dưới 3 µg/m³ thì coi như tương đương: mức chênh đó nhỏ hơn
// sai số thường gặp của dự báo, không đáng để khuyên ai đổi lịch. Ngưỡng này là giả định, cần kiểm chứng thêm.
export const SAME_REL = 0.1;
export const SAME_ABS = 3;

/**
 * So một khung giờ với giờ người dùng định đi.
 * relation: 'better' (ít bụi hơn rõ rệt) | 'worse' | 'same' (gần tương đương); pct: mức chênh theo %.
 */
export function compareWithPlan(planned, option) {
  const diff = option.mean - planned.mean;
  const pct = planned.mean > 0 ? Math.round((Math.abs(diff) / planned.mean) * 100) : 0;
  if (option.start === planned.start || Math.abs(diff) < SAME_ABS || Math.abs(diff) < planned.mean * SAME_REL) {
    return { relation: 'same', pct, diff };
  }
  return { relation: diff < 0 ? 'better' : 'worse', pct, diff };
}

/** Phần trăm giảm của `a` so với `b` (0–100). */
export function reductionPct(a, b) {
  if (!b) return 0;
  return Math.max(0, Math.round((1 - a / b) * 100));
}

export function dailyMean(series, dateStr) {
  const vals = series.times
    .map((t, i) => (datePart(t) === dateStr ? series.pm25[i] : null))
    .filter((v) => v != null);
  if (!vals.length) return null;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

// --- Trong nhà: giờ mở cửa sổ ---

// Ngưỡng trùng với mốc VN_AQI: ≤ 25 µg/m³ là mức Tốt, ≤ 50 µg/m³ là mức Trung bình.
export const VENT_STATUSES = [
  { id: 'open', max: 25, label: 'Mở thoải mái', icon: '🪟' },
  { id: 'brief', max: 50, label: 'Chỉ mở ngắn 10–15 phút', icon: '⏱️' },
  { id: 'closed', max: Infinity, label: 'Đóng kín, bật máy lọc', icon: '🚪' },
];

export function ventStatus(pm25) {
  return VENT_STATUSES.find((s) => pm25 <= s.max);
}

/**
 * Kế hoạch mở cửa sổ cho `hours` giờ tới: trạng thái từng giờ, các đoạn liên tiếp cùng trạng thái,
 * và 2 khung thông gió tốt nhất trong giờ sinh hoạt (06:00–23:00).
 */
export function ventilationPlan(series, hours = 24) {
  const end = Math.min(series.times.length, series.nowIndex + hours);
  const slots = [];
  for (let i = series.nowIndex; i < end; i++) {
    const pm25 = series.pm25[i];
    if (pm25 == null) continue;
    slots.push({ index: i, time: series.times[i], pm25, status: ventStatus(pm25) });
  }
  const runs = [];
  for (const s of slots) {
    const last = runs[runs.length - 1];
    if (last && last.status.id === s.status.id && last.end === s.index) last.end = s.index + 1;
    else runs.push({ status: s.status, start: s.index, end: s.index + 1 });
  }
  const { best } = findBestWindows(series, { scope: 'next24', fromHour: 6, toHour: 23, hours: 1 }, 2);
  return { slots, runs, best };
}

// --- Chế độ Trường học / Doanh nghiệp ---

export const ORG_PRESETS = {
  school: {
    label: 'Trường học',
    audience: 'học sinh',
    slots: [
      { name: 'Thể dục buổi sáng', from: '07:00', to: '07:45' },
      { name: 'Giờ ra chơi', from: '09:30', to: '10:00' },
      { name: 'Giờ thể dục / ngoại khóa chiều', from: '15:30', to: '16:30' },
    ],
  },
  business: {
    label: 'Doanh nghiệp',
    audience: 'người lao động ngoài trời',
    slots: [
      { name: 'Ca giao hàng sáng', from: '07:00', to: '11:00' },
      { name: 'Ca giao hàng chiều', from: '13:00', to: '17:00' },
      { name: 'Ca giao hàng tối', from: '18:00', to: '21:00' },
    ],
  },
};

const ORG_VERDICTS = {
  school: {
    good: { status: 'ok', text: 'Tổ chức bình thường' },
    moderate: { status: 'ok', text: 'Tổ chức được, để ý học sinh có bệnh hô hấp' },
    poor: { status: 'caution', text: 'Rút ngắn, giảm vận động mạnh; học sinh nhạy cảm ở trong lớp' },
    unhealthy: { status: 'stop', text: 'Chuyển hoạt động vào trong nhà' },
    'very-unhealthy': { status: 'stop', text: 'Hủy hoạt động ngoài trời, đóng cửa sổ, bật máy lọc' },
    hazardous: { status: 'stop', text: 'Hủy hoạt động ngoài trời, đóng kín cửa, bật máy lọc' },
  },
  business: {
    good: { status: 'ok', text: 'Làm việc bình thường' },
    moderate: { status: 'ok', text: 'Làm việc bình thường, chú ý nhân viên có bệnh hô hấp' },
    poor: { status: 'caution', text: 'Phát khẩu trang đạt chuẩn, cho nghỉ giữa ca trong nhà' },
    unhealthy: { status: 'caution', text: 'Bắt buộc khẩu trang N95/KN95, giảm khối lượng, xoay ca' },
    'very-unhealthy': { status: 'stop', text: 'Hoãn hoặc giảm tối đa việc ngoài trời' },
    hazardous: { status: 'stop', text: 'Tạm dừng việc ngoài trời' },
  },
};

/**
 * Đánh giá một khung hoạt động cố định trong một ngày, dùng giờ có PM2.5 cao nhất trong khung
 * (cách tiếp cận thận trọng cho nhóm đông người).
 */
export function evaluateSlot(series, dateStr, slot, orgType = 'school') {
  const from = Math.floor(parseClock(slot.from));
  const to = Math.ceil(parseClock(slot.to));
  const vals = [];
  series.times.forEach((t, i) => {
    if (datePart(t) !== dateStr) return;
    const h = hourOf(t);
    if (h >= from && h < Math.max(to, from + 1) && series.pm25[i] != null) vals.push(series.pm25[i]);
  });
  if (!vals.length) return null;
  const peak = Math.max(...vals);
  const mean = vals.reduce((sum, v) => sum + v, 0) / vals.length;
  const aqi = aqiFromConcentration(peak, 'pm2_5');
  const level = levelForAqi(aqi);
  return { peak, mean, aqi, level, ...ORG_VERDICTS[orgType][level.id] };
}
