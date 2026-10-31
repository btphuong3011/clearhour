// Số đo PM2.5 thực tế từ các trạm quan trắc và cảm biến (OpenAQ), dùng để đối chiếu với dự báo mô hình.
// Tệp data/stations.json được GitHub Actions cập nhật mỗi giờ (xem scripts/fetch-stations.mjs).

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

/** Trạm gần nhất trong bán kính `maxKm`, có số đo không cũ hơn `maxAgeHours`. */
export function nearestStation(stations, lat, lon, { maxKm = 30, maxAgeHours = 3, now = Date.now() } = {}) {
  let best = null;
  for (const s of stations) {
    if (s.pm25 == null || !s.time) continue;
    if (now - Date.parse(s.time) > maxAgeHours * 3600e3) continue;
    const km = haversineKm(lat, lon, s.lat, s.lon);
    if (km > maxKm) continue;
    if (!best || km < best.km) best = { ...s, km };
  }
  return best;
}
