// Dữ liệu dự báo chất lượng không khí từ Open-Meteo Air Quality API
// (mô hình CAMS của Copernicus) và dự báo thời tiết từ Open-Meteo Forecast API.
// Miễn phí cho mục đích phi thương mại, không cần API key.

const ENDPOINT = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const WEATHER_ENDPOINT = 'https://api.open-meteo.com/v1/forecast';
const WEATHER_VARS = 'precipitation_probability,precipitation,apparent_temperature,uv_index';
const SAMPLE_URL = './data/sample-hanoi.json';
const TTL_MS = 15 * 60 * 1000;
const cache = new Map();

/** Đặt dữ liệu thời tiết vào đúng từng giờ của chuỗi chất lượng không khí (cùng giờ địa phương). */
export function alignWeather(times, raw) {
  if (!raw?.hourly?.time) return null;
  const at = new Map(raw.hourly.time.map((t, i) => [t, i]));
  const pick = (key) => times.map((t) => (at.has(t) ? raw.hourly[key]?.[at.get(t)] ?? null : null));
  return {
    rainProb: pick('precipitation_probability'),
    rain: pick('precipitation'),
    feels: pick('apparent_temperature'),
    uv: pick('uv_index'),
  };
}

export function normalize(raw, source, weatherRaw = raw.weather) {
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
    o3: raw.hourly.ozone ?? null,
    weather: alignWeather(times, weatherRaw),
    nowIndex,
    current: { pm25: raw.current.pm2_5, pm10: raw.current.pm10, o3: raw.current.ozone ?? null, time: raw.current.time },
    gridLat: raw.latitude,
    gridLon: raw.longitude,
  };
}

async function getJson(url, ms = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchAirQuality(lat, lon) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  const common = { latitude: lat, longitude: lon, timezone: 'auto', past_days: 1, forecast_days: 4 };
  const air = new URLSearchParams({ ...common, current: 'pm2_5,pm10,ozone', hourly: 'pm2_5,pm10,ozone' });
  const weather = new URLSearchParams({ ...common, hourly: WEATHER_VARS });
  // Thời tiết chỉ để cảnh báo thêm: lỗi thì vẫn chạy với dữ liệu bụi
  const [rawAir, rawWeather] = await Promise.all([
    getJson(`${ENDPOINT}?${air}`),
    getJson(`${WEATHER_ENDPOINT}?${weather}`).catch(() => null),
  ]);
  const data = normalize(rawAir, 'live', rawWeather);
  cache.set(key, { at: Date.now(), data });
  return data;
}

/**
 * Dữ liệu từng giờ của khoảng 30 ngày qua (mô hình chạy lại, không phải bản dự báo đã phát hành),
 * dùng cho phần "Nhìn lại 30 ngày" và bản đồ "giờ thường sạch".
 */
export async function fetchHistory(lat, lon, days = 30) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    hourly: 'pm2_5,ozone',
    timezone: 'auto',
    past_days: days + 1,
    forecast_days: 1,
  });
  const raw = await getJson(`${ENDPOINT}?${params}`, 15000);
  return { times: raw.hourly.time, pm25: raw.hourly.pm2_5, o3: raw.hourly.ozone ?? null, utcOffsetSeconds: raw.utc_offset_seconds ?? 0 };
}

/** Dữ liệu mẫu đã lưu sẵn, dùng khi API không truy cập được để bản demo luôn chạy. */
export async function fetchSample() {
  const res = await fetch(SAMPLE_URL);
  return normalize(await res.json(), 'sample');
}
