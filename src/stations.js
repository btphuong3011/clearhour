// Số đo PM2.5 thực tế từ các trạm quan trắc và cảm biến (OpenAQ), dùng để đối chiếu với dự báo mô hình.
// Tệp data/stations.json do GitHub Actions cập nhật (xem scripts/fetch-stations.mjs). Lịch đặt mỗi giờ
// nhưng GitHub chạy không đều, thực tế có khi 6–8 tiếng mới một lần, nên số đo có thể cũ vài giờ.

const STATIONS_URL = './data/stations.json';

export async function fetchStations() {
  try {
    const res = await fetch(STATIONS_URL, { cache: 'no-cache' });
    if (!res.ok) return [];
    const doc = await res.json();
    return Array.isArray(doc.stations) ? doc.stations : [];
  } catch {
    return [];
  }
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

/**
 * Trạm gần nhất trong bán kính `maxKm`, có số đo không cũ hơn `maxAgeHours`.
 * Ưu tiên trạm quan trắc chuẩn; chỉ dùng cảm biến giá rẻ khi quanh đó không có trạm chuẩn.
 */
export function nearestStation(stations, lat, lon, { maxKm = 30, maxAgeHours = 12, now = Date.now() } = {}) {
  let best = null;
  for (const s of stations) {
    if (s.pm25 == null || !s.time) continue;
    if (now - Date.parse(s.time) > maxAgeHours * 3600e3) continue;
    const km = haversineKm(lat, lon, s.lat, s.lon);
    if (km > maxKm) continue;
    const better = !best || (s.isMonitor && !best.isMonitor) || (s.isMonitor === best.isMonitor && km < best.km);
    if (better) best = { ...s, km };
  }
  return best;
}

/**
 * Số đo trạm và dự báo mô hình (cùng giờ) có khớp nhau không.
 * Coi là khớp khi chênh không quá 10 µg/m³ hoặc không quá 1,5 lần. Ngưỡng này là giả định.
 * Trả về 'agree' | 'station-higher' | 'station-lower'; một mẫu đơn lẻ không cho biết nguồn nào đúng hơn.
 */
export function compareWithModel(stationPm25, modelPm25) {
  if (stationPm25 == null || modelPm25 == null) return null;
  const diff = stationPm25 - modelPm25;
  const ratio = Math.max(stationPm25, modelPm25) / Math.max(Math.min(stationPm25, modelPm25), 1);
  if (Math.abs(diff) <= 10 || ratio <= 1.5) return 'agree';
  return diff > 0 ? 'station-higher' : 'station-lower';
}

/** Thời điểm đo (UTC) -> giờ địa phương "YYYY-MM-DDTHH:MM". */
export function toLocalTime(utc, utcOffsetSeconds = 0) {
  return new Date(Date.parse(utc) + utcOffsetSeconds * 1000).toISOString().slice(0, 16);
}

/** Độ cũ của số đo, dạng chữ: "vừa cập nhật", "25 phút trước", "7 giờ trước". */
export function ageText(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 5) return 'vừa cập nhật';
  if (minutes < 60) return `${minutes} phút trước`;
  return `${Math.round(minutes / 60)} giờ trước`;
}
