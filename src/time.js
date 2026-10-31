// Open-Meteo trả về giờ địa phương dạng "YYYY-MM-DDTHH:MM" (không kèm múi giờ).
// Xử lý thẳng trên chuỗi để không bị lệch múi giờ theo máy người xem.

const WEEKDAYS = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];

export const datePart = (t) => t.slice(0, 10);
export const hourOf = (t) => Number(t.slice(11, 13));

export function weekday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

export function shortDate(dateStr) {
  const [, m, d] = dateStr.split('-');
  return `${d}/${m}`;
}

export function dayLabel(dateStr, todayStr) {
  if (dateStr === todayStr) return 'Hôm nay';
  if (dateStr === addDays(todayStr, 1)) return 'Ngày mai';
  return weekday(dateStr);
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

/** "07:30" -> 7.5 */
export function parseClock(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h + (m || 0) / 60;
}

/** 7.5 -> "07:30" (24 -> "24:00") */
export function formatClock(hours) {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
