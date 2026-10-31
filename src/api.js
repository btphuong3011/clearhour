// Dữ liệu dự báo chất lượng không khí từ Open-Meteo Air Quality API
// (mô hình CAMS của Copernicus). Miễn phí cho mục đích phi thương mại, không cần API key.

const ENDPOINT = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const SAMPLE_URL = './data/sample-hanoi.json';
const TTL_MS = 15 * 60 * 1000;
const cache = new Map();

export function normalize(raw, source) {
  const times = raw.hourly.time;
  const currentHour = `${raw.current.time.slice(0, 13)}:00`;
  let nowIndex = times.indexOf(currentHour);
  if (nowIndex < 0) nowIndex = times.findIndex((t) => t > currentHour) - 1;
  if (nowIndex < 0) nowIndex = 0;
  return {
    source,
    timezone: raw.timezone,
    utcOffsetSeconds: raw.utc_offset_seconds ?? 0,
    times,
    pm25: raw.hourly.pm2_5,
    pm10: raw.hourly.pm10,
    nowIndex,
    current: { pm25: raw.current.pm2_5, pm10: raw.current.pm10, time: raw.current.time },
    gridLat: raw.latitude,
    gridLon: raw.longitude,
  };
}

export async function fetchAirQuality(lat, lon) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    current: 'pm2_5,pm10',
    hourly: 'pm2_5,pm10',
    timezone: 'auto',
    past_days: 1,
    forecast_days: 4,
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(`${ENDPOINT}?${params}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = normalize(await res.json(), 'live');
    cache.set(key, { at: Date.now(), data });
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** Dữ liệu mẫu đã lưu sẵn, dùng khi API không truy cập được để bản demo luôn chạy. */
export async function fetchSample() {
  const res = await fetch(SAMPLE_URL);
  return normalize(await res.json(), 'sample');
}
