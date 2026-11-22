// Dữ liệu dự báo chất lượng không khí từ Open-Meteo Air Quality API
// (mô hình CAMS của Copernicus) và dự báo thời tiết từ Open-Meteo Forecast API.
// Miễn phí cho mục đích phi thương mại, không cần API key.

const ENDPOINT = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const WEATHER_ENDPOINT = 'https://api.open-meteo.com/v1/forecast';
const WEATHER_VARS = 'precipitation_probability,precipitation,apparent_temperature,uv_index';
const SAMPLE_URL = './data/sample-hanoi.json';
const TTL_MS = 15 * 60 * 1000;
const forecastCache = new Map();
const weatherCache = new Map();
const forecastParams = (latitude, longitude) => ({ latitude, longitude, timezone: 'auto', past_days: 1, forecast_days: 4 });

/** Đặt dữ liệu thời tiết vào đúng từng giờ của chuỗi chất lượng không khí (cùng giờ địa phương). */
export function alignWeather(times, raw) {
  if (!raw?.hourly?.time?.length) return null;
  const at = new Map(raw.hourly.time.map((t, i) => [t, i]));
  const pick = (key) => times.map((t) => (at.has(t) ? raw.hourly[key]?.[at.get(t)] ?? null : null));
  const weather = {
    rainProb: pick('precipitation_probability'),
    rain: pick('precipitation'),
    feels: pick('apparent_temperature'),
    uv: pick('uv_index'),
  };
  return [weather.rainProb, weather.feels, weather.uv].some((values) => values.some(Number.isFinite)) ? weather : null;
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

async function cachedForecast(cache, url, read) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  const data = await read(url);
  cache.set(url, { at: Date.now(), data });
  return data;
}

export function fetchAirQuality(lat, lon) {
  const air = new URLSearchParams({ ...forecastParams(lat, lon), current: 'pm2_5,pm10,ozone', hourly: 'pm2_5,pm10,ozone' });
  return cachedForecast(forecastCache, `${ENDPOINT}?${air}`, async (url) => normalize(await getJson(url), 'live'));
}

export function fetchWeather(lat, lon) {
  const params = new URLSearchParams({ ...forecastParams(lat, lon), hourly: WEATHER_VARS });
  return cachedForecast(weatherCache, `${WEATHER_ENDPOINT}?${params}`, getJson);
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
