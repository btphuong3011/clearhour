import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { airQualityUrl, weatherUrl } from '../src/api.js';
import { CITIES } from '../src/cities.js';

const ACCURACY_URL = 'https://btphuong3011.github.io/clearhour/data/accuracy.json';
const coords = (key) => CITIES.map((city) => city[key]).join(',');
const AIR_FIELDS = ['pm2_5', 'pm10', 'ozone'];
const WEATHER_FIELDS = ['precipitation_probability', 'precipitation', 'apparent_temperature', 'uv_index'];

function unpackBatch(payload, fields) {
  if (!Array.isArray(payload) || payload.length !== CITIES.length) {
    throw new Error('Unexpected number of forecast locations');
  }
  return payload.map((row, index) => {
    if ((row.location_id ?? 0) !== index) throw new Error('Unexpected forecast location order');
    const { time } = row.hourly ?? {};
    if (!Array.isArray(time) || !time.length || !fields.every((key) => row.hourly[key]?.length === time.length)) {
      throw new Error('Incomplete hourly forecast for location ' + index);
    }
    return { ...row, location_id: index };
  });
}

async function collectSource(url, read, validate) {
  // Giờ lấy dữ liệu của ClearHour. Nhà cung cấp có thể không công bố giờ mô hình khởi chạy.
  const fetchedAt = new Date().toISOString();
  try {
    return { fetchedAt, url, data: validate(await read(url)) };
  } catch (error) {
    return { fetchedAt, url, error: error.message };
  }
}

async function getJson(url) {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.json();
}

export async function captureForecast({ read = getJson, revision = null } = {}) {
  const lat = coords('lat');
  const lon = coords('lon');
  const [air, weather, correction] = await Promise.all([
    collectSource(airQualityUrl(lat, lon), read, (data) => unpackBatch(data, AIR_FIELDS)),
    collectSource(weatherUrl(lat, lon), read, (data) => unpackBatch(data, WEATHER_FIELDS)),
    collectSource(ACCURACY_URL, read, (data) => {
      if (!Array.isArray(data?.stations)) throw new Error('Invalid correction data');
      return data;
    }),
  ]);
  if (!air.data) throw new Error('Air forecast unavailable: ' + air.error);
  return {
    schema: 1,
    revision,
    capturedAt: air.fetchedAt,
    cities: CITIES.map(({ id, name, lat, lon }) => ({ id, name, lat, lon })),
    sources: { air, weather, correction },
  };
}

async function main(dir) {
  const snapshot = await captureForecast({ revision: process.env.GITHUB_SHA ?? null });
  const [date] = snapshot.capturedAt.split('T');
  const stamp = snapshot.capturedAt.replaceAll(':', '-');
  const folder = join(dir, date);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, stamp + '.json'), JSON.stringify(snapshot) + '\n', { flag: 'wx' });
  console.log('Captured ClearHour forecast for ' + snapshot.cities.length + ' cities at ' + snapshot.capturedAt);
  for (const [name, source] of Object.entries(snapshot.sources)) {
    if (source.error) console.warn(name + ': ' + source.error);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/capture-forecast.mjs <output directory>');
  await main(process.argv[2]);
}
