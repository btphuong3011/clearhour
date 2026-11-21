// Kiểm tra dự báo PM2.5 của mô hình (Open-Meteo / CAMS) so với số đo thật của các trạm trong ~60 ngày qua,
// rồi tính hệ số hiệu chỉnh theo giờ trong ngày cho từng trạm.
//
// Chạy: node scripts/accuracy.mjs data/stations.json data/accuracy.json [--stations-url URL] [--reuse URL]
//  - Danh sách trạm lấy từ data/stations.json (do fetch-stations.mjs ghi); tệp rỗng thì đọc từ --stations-url.
//  - Số đo lấy từ kho lưu trữ công khai của OpenAQ trên AWS (openaq-data-archive), không cần API key.
//  - --reuse: nếu bản đang chạy trên web còn mới (dưới 20 giờ) và cùng phiên bản cách tính thì dùng lại.
//
// Lưu ý trung thực: dữ liệu quá khứ của Open-Meteo là mô hình chạy sát giờ (gần với phân tích),
// không phải bản dự báo trước 1–3 ngày mà người dùng xem. Sai số thật của dự báo xa thường lớn hơn.

import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { aqiFromConcentration, levelForAqi } from '../src/aqi.js';

export const VERSION = 1;
const ARCHIVE = 'https://openaq-data-archive.s3.amazonaws.com';
const MODEL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const UTC_OFFSET_HOURS = 7; // giờ Việt Nam, dùng cho "giờ trong ngày" và "ban ngày"
const DAYS = 60;
const SHRINK_K = 10;
const CLAMP = [0.25, 4];
const MIN_TRAIN = 150;
const MIN_TEST = 72;
const ORDER_MIN_DIFF = 5; // µg/m³: chỉ so thứ tự hai giờ khi số đo chênh nhau rõ
const DAY_HOURS = [5, 22]; // giờ địa phương, khung người dùng hay ra ngoài

const round = (v, d = 1) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const localHour = (utcMs) => new Date(utcMs + UTC_OFFSET_HOURS * 3600e3).getUTCHours();
const localDay = (utcMs) => new Date(utcMs + UTC_OFFSET_HOURS * 3600e3).toISOString().slice(0, 10);
const levelIndex = (pm) => levelForAqi(aqiFromConcentration(pm, 'pm2_5'))?.id;

// ---------- Phần tính toán (thuần, có test) ----------

/**
 * Hệ số theo giờ (UTC) = tổng số đo / tổng dự báo của giờ đó, kéo về hệ số chung khi ít mẫu,
 * làm trơn với hai giờ bên cạnh và giới hạn trong [0.25, 4].
 */
export function fitFactors(pairs) {
  const obs = Array(24).fill(0);
  const mod = Array(24).fill(0);
  const n = Array(24).fill(0);
  let so = 0;
  let sm = 0;
  for (const p of pairs) {
    const h = new Date(p.t).getUTCHours();
    obs[h] += p.obs;
    mod[h] += p.model;
    n[h] += 1;
    so += p.obs;
    sm += p.model;
  }
  const global = sm > 0 ? so / sm : 1;
  const raw = obs.map((o, h) => (mod[h] > 0 ? (n[h] * (o / mod[h]) + SHRINK_K * global) / (n[h] + SHRINK_K) : global));
  return raw.map((r, h) => {
    const smooth = (raw[(h + 23) % 24] + 2 * r + raw[(h + 1) % 24]) / 4;
    return round(Math.min(CLAMP[1], Math.max(CLAMP[0], smooth)), 3);
  });
}

export const applyFactors = (pairs, factors) => pairs.map((p) => ({ ...p, model: p.model * factors[new Date(p.t).getUTCHours()] }));

/** Tỉ lệ cặp giờ (cùng ngày, ban ngày, số đo chênh ≥ 5 µg/m³) mà mô hình xếp đúng giờ nào ít bụi hơn. */
export function orderAccuracy(pairs) {
  const byDay = new Map();
  for (const p of pairs) {
    const h = localHour(p.t);
    if (h < DAY_HOURS[0] || h >= DAY_HOURS[1]) continue;
    const d = localDay(p.t);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(p);
  }
  let total = 0;
  let right = 0;
  for (const list of byDay.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const dObs = list[i].obs - list[j].obs;
        if (Math.abs(dObs) < ORDER_MIN_DIFF) continue;
        const dMod = list[i].model - list[j].model;
        total += 1;
        right += dMod === 0 ? 0.5 : Math.sign(dMod) === Math.sign(dObs) ? 1 : 0;
      }
    }
  }
  return { rate: total ? right / total : null, pairs: total };
}

export function scores(pairs) {
  const n = pairs.length;
  if (!n) return { n: 0 };
  let abs = 0;
  let bias = 0;
  let level = 0;
  for (const p of pairs) {
    abs += Math.abs(p.model - p.obs);
    bias += p.obs - p.model;
    if (levelIndex(p.obs) === levelIndex(p.model)) level += 1;
  }
  const order = orderAccuracy(pairs);
  return { n, mae: abs / n, bias: bias / n, level: level / n, order: order.rate, orderPairs: order.pairs };
}

/**
 * Chia theo thời gian: 2/3 đầu để tính hệ số, 1/3 sau để kiểm tra (không dùng lại dữ liệu đã học).
 * Chỉ bật hiệu chỉnh khi trạm là trạm quan trắc chuẩn, đủ dữ liệu, sai số giảm ít nhất 5%
 * và thứ tự giờ không kém đi quá 2 điểm phần trăm. Hệ số đưa lên web tính lại trên toàn bộ dữ liệu.
 */
export function evaluateStation(pairs, { isMonitor = true } = {}) {
  const sorted = [...pairs].sort((a, b) => a.t - b.t);
  const cut = Math.floor((sorted.length * 2) / 3);
  const train = sorted.slice(0, cut);
  const test = sorted.slice(cut);
  const result = { n: sorted.length, days: new Set(sorted.map((p) => localDay(p.t))).size };
  if (train.length < MIN_TRAIN || test.length < MIN_TEST) return { ...result, apply: false, reason: 'few-data', factors: null, test: null };

  const raw = scores(test);
  const corr = scores(applyFactors(test, fitFactors(train)));
  const better = corr.mae < raw.mae * 0.95 && (corr.order ?? 0) >= (raw.order ?? 0) - 0.02;
  const apply = isMonitor && better;
  return {
    ...result,
    test: {
      n: raw.n,
      from: new Date(test[0].t).toISOString(),
      to: new Date(test.at(-1).t).toISOString(),
      maeRaw: round(raw.mae),
      maeCorr: round(corr.mae),
      biasRaw: round(raw.bias),
      levelRaw: round(raw.level, 3),
      levelCorr: round(corr.level, 3),
      orderRaw: round(raw.order, 3),
      orderCorr: round(corr.order, 3),
      orderPairs: raw.orderPairs,
    },
    factors: fitFactors(sorted),
    apply,
    reason: apply ? null : !isMonitor ? 'low-cost' : 'no-gain',
  };
}

/** Ghép số đo (giờ bắt đầu, UTC) với dự báo cùng giờ. */
export function pairUp(observations, model) {
  const at = new Map(model.times.map((t, i) => [t, model.pm25[i]]));
  const out = [];
  for (const o of observations) {
    const m = at.get(o.t);
    if (m == null || !(m > 0)) continue;
    out.push({ t: o.t, obs: o.value, model: m });
  }
  return out;
}

/**
 * Đọc CSV của kho lưu trữ OpenAQ, chỉ lấy PM2.5 hợp lệ.
 * Cột datetime là thời điểm kết thúc của giờ đo (quy ước của OpenAQ), nên lùi 1 giờ để ra giờ bắt đầu.
 */
export function parseArchiveCsv(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  const head = lines.shift()?.split(',').map((h) => h.replace(/"/g, ''));
  if (!head) return out;
  const col = (name) => head.indexOf(name);
  const [iParam, iTime, iValue] = [col('parameter'), col('datetime'), col('value')];
  for (const line of lines) {
    if (!line.trim()) continue;
    const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, ''));
    if (cells[iParam] !== 'pm25') continue;
    const value = Number(cells[iValue]);
    const end = Date.parse(cells[iTime]);
    if (!Number.isFinite(value) || !Number.isFinite(end) || value <= 0 || value >= 1000) continue;
    out.push({ t: end - 3600e3, value });
  }
  // Một giờ có thể có nhiều cảm biến PM2.5: lấy trung bình
  const byHour = new Map();
  for (const o of out) {
    const v = byHour.get(o.t) ?? [];
    v.push(o.value);
    byHour.set(o.t, v);
  }
  return [...byHour].map(([t, v]) => ({ t, value: v.reduce((a, b) => a + b, 0) / v.length })).sort((a, b) => a.t - b.t);
}

// ---------- Lấy dữ liệu ----------

async function fetchText(url, { gzip = false, tries = 3 } = {}) {
  for (let k = 1; ; k++) {
    try {
      const res = await fetch(url);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return gzip ? gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8') : await res.text();
    } catch (err) {
      if (k >= tries) throw err;
      await new Promise((r) => setTimeout(r, 1000 * k));
    }
  }
}

async function archiveKeys(locationId, months) {
  const keys = [];
  for (const [y, m] of months) {
    const xml = await fetchText(`${ARCHIVE}/?list-type=2&prefix=records/csv.gz/locationid=${locationId}/year=${y}/month=${m}/`);
    if (xml) keys.push(...[...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((x) => x[1]));
  }
  return keys;
}

async function observationsFor(station, from, to) {
  const months = [];
  for (let d = new Date(from); d <= to; d.setUTCMonth(d.getUTCMonth() + 1, 1)) {
    months.push([d.getUTCFullYear(), String(d.getUTCMonth() + 1).padStart(2, '0')]);
  }
  const fromDay = from.toISOString().slice(0, 10).replace(/-/g, '');
  const toDay = to.toISOString().slice(0, 10).replace(/-/g, '');
  const keys = (await archiveKeys(station.id, months)).filter((k) => {
    const day = k.match(/-(\d{8})\.csv\.gz$/)?.[1];
    return day && day >= fromDay && day <= toDay;
  });
  const all = [];
  // Tải song song từng nhóm nhỏ để không dồn quá nhiều request một lúc
  for (let i = 0; i < keys.length; i += 8) {
    const texts = await Promise.all(keys.slice(i, i + 8).map((k) => fetchText(`${ARCHIVE}/${k}`, { gzip: true }).catch(() => null)));
    for (const text of texts) if (text) all.push(...parseArchiveCsv(text));
  }
  return all;
}

async function modelFor(station, from, to) {
  const params = new URLSearchParams({
    latitude: station.lat,
    longitude: station.lon,
    hourly: 'pm2_5',
    timezone: 'GMT',
    start_date: from.toISOString().slice(0, 10),
    end_date: to.toISOString().slice(0, 10),
  });
  const raw = JSON.parse(await fetchText(`${MODEL}?${params}`));
  return { times: raw.hourly.time.map((t) => Date.parse(`${t}:00Z`)), pm25: raw.hourly.pm2_5 };
}

async function readStations(file, url) {
  try {
    const doc = JSON.parse(await readFile(file, 'utf8'));
    if (doc.stations?.length) return doc.stations;
  } catch { /* tệp chưa có, thử URL */ }
  if (!url) return [];
  const text = await fetchText(url);
  return text ? JSON.parse(text).stations ?? [] : [];
}

/** Bản đang chạy trên web (cùng phiên bản cách tính, có dữ liệu), kèm cờ còn mới hay không. */
async function previous(url, now) {
  if (!url) return null;
  try {
    const text = await fetchText(url, { tries: 1 });
    const doc = text && JSON.parse(text);
    if (doc?.version !== VERSION || !doc.stations?.length) return null;
    return { doc, fresh: now - Date.parse(doc.generatedAt) < 20 * 3600e3 };
  } catch {
    return null;
  }
}

async function main(stationsFile, outFile, opts) {
  const now = Date.now();
  const prev = await previous(opts.reuse, now);
  const reuse = async (doc) => {
    await writeFile(outFile, `${JSON.stringify(doc, null, 2)}\n`);
    console.log(`Dùng lại kết quả lúc ${doc.generatedAt} (${doc.stations.length} trạm)`);
  };
  if (prev?.fresh) return reuse(prev.doc);
  // Kho lưu trữ thường chậm 2–3 ngày nên lấy đến hôm kia
  const to = new Date(now - 2 * 86400e3);
  const from = new Date(to.getTime() - DAYS * 86400e3);
  const stations = await readStations(stationsFile, opts.stationsUrl);
  const doc = {
    version: VERSION,
    generatedAt: new Date(now).toISOString(),
    source: 'OpenAQ archive + Open-Meteo (CAMS)',
    window: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
    stations: [],
  };
  for (const st of stations) {
    try {
      const [obs, model] = await Promise.all([observationsFor(st, from, to), modelFor(st, from, to)]);
      const result = evaluateStation(pairUp(obs, model), { isMonitor: st.isMonitor });
      doc.stations.push({ id: st.id, name: st.name, lat: st.lat, lon: st.lon, isMonitor: Boolean(st.isMonitor), provider: st.provider ?? null, ...result });
      console.log(`${st.name}: ${result.n} giờ, ${result.apply ? 'hiệu chỉnh' : `không hiệu chỉnh (${result.reason})`}`);
    } catch (err) {
      console.warn(`Bỏ qua trạm ${st.id}: ${err.message}`);
    }
  }
  // Lần này không lấy được trạm nào (mất mạng, danh sách trạm rỗng) thì giữ bản cũ còn hơn để trống
  if (!doc.stations.length && prev) return reuse(prev.doc);
  await writeFile(outFile, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`Đã ghi ${doc.stations.length} trạm vào ${outFile}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i < 0 ? null : args.splice(i, 2)[1];
  };
  const opts = { stationsUrl: flag('--stations-url'), reuse: flag('--reuse') };
  await main(args[0] ?? 'data/stations.json', args[1] ?? 'data/accuracy.json', opts);
}
