import { language, t } from './i18n.js';
// Open-Meteo trả về giờ địa phương dạng "YYYY-MM-DDTHH:MM" (không kèm múi giờ).
// Xử lý thẳng trên chuỗi để không bị lệch múi giờ theo máy người xem.

const WEEKDAYS = [t('Chủ nhật'), t('Thứ Hai'), t('Thứ Ba'), t('Thứ Tư'), t('Thứ Năm'), t('Thứ Sáu'), t('Thứ Bảy')];

export const datePart = (t) => t.slice(0, 10);
export const hourOf = (t) => Number(t.slice(11, 13));

export function weekday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function shortDate(dateStr, withYear = false) {
  const [y, m, d] = dateStr.split('-');
  if (language === 'en') return `${Number(d)} ${months[Number(m) - 1]}${withYear ? ' ' + y : ''}`;
  return `${d}/${m}${withYear ? '/' + y : ''}`;
}

export function dayLabel(dateStr, todayStr) {
  if (dateStr === todayStr) return t('Hôm nay');
  if (dateStr === addDays(todayStr, 1)) return t('Ngày mai');
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

/** Buổi trong ngày theo cách nói thường ngày. */
export function dayPeriod(hour) {
  const h = Math.floor(hour) % 24;
  if (h === 0 || h >= 23) return 'đêm';
  if (h <= 10) return 'sáng';
  if (h <= 12) return 'trưa';
  if (h <= 17) return 'chiều';
  return 'tối';
}

/** Giờ dễ đọc cho mọi người: 17 -> "5:00 chiều", 7.5 -> "7:30 sáng", 0 hoặc 24 -> "12:00 đêm". */
export function friendlyClock(hours) {
  const h = Math.floor(hours) % 24;
  const m = Math.round((hours - Math.floor(hours)) * 60);
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  if (language === 'en') return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
  return `${h12}:${String(m).padStart(2, '0')} ${dayPeriod(h)}`;
}
