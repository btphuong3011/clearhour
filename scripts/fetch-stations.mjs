// Lấy số đo PM2.5 mới nhất của các trạm tại Việt Nam từ OpenAQ API v3 và ghi ra JSON tĩnh cho web app.
// Chạy: OPENAQ_API_KEY=... node scripts/fetch-stations.mjs data/stations.json
// Thiếu API key thì vẫn ghi tệp rỗng để bản web chạy bình thường.

import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const API = 'https://api.openaq.org/v3';
const PM25 = 2; // parameters_id của PM2.5 trên OpenAQ
const VIETNAM_BBOX = '102.1,8.4,109.6,23.4'; // minLon,minLat,maxLon,maxLat
const MAX_STATIONS = 200;

export async function collectStations(getJson, { now = Date.now(), maxAgeHours = 6, pauseMs = 0 } = {}) {
  const isFresh = (utc) => utc && now - Date.parse(utc) <= maxAgeHours * 3600e3;
  const locs = await getJson(`${API}/locations?bbox=${VIETNAM_BBOX}&parameters_id=${PM25}&limit=1000`);
  // Khung bbox chồng lên Lào, Campuchia, Thái Lan, Trung Quốc nên lọc lại theo mã quốc gia
  const fresh = locs.results
    .filter((l) => !l.country?.code || l.country.code === 'VN')
    .filter((l) => isFresh(l.datetimeLast?.utc))
    .slice(0, MAX_STATIONS);

  const stations = [];
  for (const loc of fresh) {
    const sensor = loc.sensors?.find((s) => s.parameter?.id === PM25 || s.parameter?.name === 'pm25');
    if (!sensor) continue;
    try {
      const latest = await getJson(`${API}/locations/${loc.id}/latest`);
      const m = latest.results.find((r) => r.sensorsId === sensor.id);
      // Bỏ số đo cũ (trạm còn chạy nhưng cảm biến PM2.5 đã ngừng) và giá trị 0 hay quá lớn (thường do lỗi cảm biến)
      if (m && isFresh(m.datetime?.utc) && m.value > 0 && m.value < 1000) {
        stations.push({
          id: loc.id,
          name: loc.name.trim(),
          lat: loc.coordinates.latitude,
          lon: loc.coordinates.longitude,
          pm25: Math.round(m.value * 10) / 10,
          time: m.datetime.utc,
          isMonitor: Boolean(loc.isMonitor),
          provider: loc.provider?.name ?? null,
        });
      }
    } catch (err) {
      console.warn(`Bỏ qua trạm ${loc.id}: ${err.message}`);
    }
    if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
  }
  return stations;
}

async function main(outFile) {
  const key = process.env.OPENAQ_API_KEY;
  const doc = { generatedAt: new Date().toISOString(), source: 'OpenAQ', stations: [] };
  if (!key) {
    doc.error = 'missing-api-key';
    console.warn('Chưa có OPENAQ_API_KEY, ghi danh sách trạm rỗng.');
  } else {
    const getJson = async (url) => {
      const res = await fetch(url, { headers: { 'X-API-Key': key, accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return res.json();
    };
    try {
      // OpenAQ giới hạn 60 request/phút
      doc.stations = await collectStations(getJson, { pauseMs: 1100 });
    } catch (err) {
      doc.error = err.message;
      console.error(err);
    }
  }
  await writeFile(outFile, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`Đã ghi ${doc.stations.length} trạm vào ${outFile}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv[2] ?? 'data/stations.json');
}
