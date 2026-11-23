import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { accuracyNear, correctSeries } from '../src/accuracy.js';
import { normalize } from '../src/api.js';
import { localToUtc } from '../src/calendar.js';
import { CITIES } from '../src/cities.js';
import { decideOutdoorPlan } from '../src/conditions.js';
import { compareWithPlan, windowStats } from '../src/planner.js';
import { addDays, formatClock } from '../src/time.js';
import { observationsFor } from './accuracy.mjs';

const CITY = CITIES.find(({ id }) => id === 'hanoi');
const REFERENCE = { id: 4946812, name: 'Công viên Nhân Chính - Khuất Duy Tiến' };
const LEADS = [6, 12, 24];
const PLANNED_HOURS = [8, 12, 17];
const HOUR = 3600_000;
const OFFSET = 7 * 3600;
const MAX_SNAPSHOT_AGE = 6 * HOUR;
const MIN_REFERENCE_SAMPLES_PER_HOUR = 9; // Trạm công bố 12 mẫu 5 phút mỗi giờ.
const MIN_SCORED = 20;
const MIN_DAYS = 7;
const VERSION = 1;
const localDay = (time) => new Date(time + OFFSET * 1000).toISOString().slice(0, 10);
const clock = (day, hour) => day + 'T' + formatClock(hour);

function scenariosFor(day, snapshot, deadline) {
  const cityIndex = snapshot.cities.findIndex(({ id }) => id === CITY.id);
  const air = snapshot.sources.air.data?.[cityIndex];
  const weather = snapshot.sources.weather.data?.[cityIndex];
  if (!air || !weather) return null;
  const raw = normalize(air, 'archive', weather);
  // So từ thời điểm giả định người dùng mở app, chỉ xét các giờ bắt đầu sau đó.
  const nowIndex = raw.times.findIndex((time) => +localToUtc(time, raw.utcOffsetSeconds) >= deadline);
  if (nowIndex < 0 || !raw.weather) return null;
  raw.nowIndex = nowIndex;
  const correction = snapshot.sources.correction?.data;
  const entry = Date.parse(correction?.generatedAt) <= Date.parse(snapshot.availableAt ?? snapshot.capturedAt)
    ? accuracyNear(correction, CITY.lat, CITY.lon) : null;
  const corrected = correctSeries(raw, entry);
  const opts = { scope: localDay(deadline) === day ? 'today' : 'tomorrow', ranges: [{ from: 6, to: 22 }], hours: 1 };
  return { raw, corrected, opts };
}

function record(counts, dates, decision, series, day, observations) {
  if (decision.outcome !== 'switch') return;
  counts.switches += 1;
  const observed = (index) => observations.get(+localToUtc(series.times[index], series.utcOffsetSeconds));
  const planned = observed(decision.mine.start);
  const suggested = observed(decision.top.start);
  if (!Number.isFinite(planned) || !Number.isFinite(suggested)) return;
  const { relation } = compareWithPlan(
    { start: decision.mine.start, mean: planned },
    { start: decision.top.start, mean: suggested },
  );
  counts[relation] += 1;
  dates.add(day);
}

const counter = () => ({ switches: 0, better: 0, same: 0, worse: 0 });

function finish(counts, dates) {
  const scored = counts.better + counts.same + counts.worse;
  return {
    ...counts,
    scored,
    days: dates.size,
    rate: scored >= MIN_SCORED && dates.size >= MIN_DAYS ? counts.better / scored : null,
  };
}

export function scoreForecastArchive(snapshots, hourlyObservations, { firstDay, lastDay }) {
  const archive = snapshots
    .filter((snapshot) => snapshot.schema === 1)
    .map((snapshot) => ({ snapshot, availableAt: Date.parse(snapshot.availableAt ?? snapshot.capturedAt) }))
    .filter(({ availableAt }) => Number.isFinite(availableAt))
    .sort((a, b) => a.availableAt - b.availableAt);
  const observations = new Map(hourlyObservations.map(({ t, value }) => [t, value]));
  return LEADS.map((hours) => {
    let scenarios = 0;
    let available = 0;
    let leadSum = 0;
    const app = counter();
    const raw = counter();
    const appDates = new Set();
    const rawDates = new Set();
    for (let day = firstDay; day <= lastDay; day = addDays(day, 1)) {
      for (const hour of PLANNED_HOURS) {
        scenarios += 1;
        const intended = clock(day, hour);
        const start = +localToUtc(intended, OFFSET);
        const deadline = start - hours * HOUR;
        const capture = archive.findLast(({ availableAt }) => availableAt <= deadline);
        if (!capture || deadline - capture.availableAt > MAX_SNAPSHOT_AGE) continue;
        const inputs = scenariosFor(day, capture.snapshot, deadline);
        if (!inputs) continue;
        const planned = inputs.raw.times.indexOf(intended);
        if (planned < inputs.raw.nowIndex || !windowStats(inputs.raw.pm25, planned, 1)) continue;
        available += 1;
        leadSum += (start - capture.availableAt) / HOUR;
        record(app, appDates, decideOutdoorPlan(inputs.corrected, inputs.opts, planned), inputs.corrected, day, observations);
        record(raw, rawDates, decideOutdoorPlan(inputs.raw, inputs.opts, planned), inputs.raw, day, observations);
      }
    }
    return {
      hours, scenarios, available, meanLeadHours: available ? leadSum / available : null,
      app: finish(app, appDates), raw: finish(raw, rawDates),
    };
  });
}

async function readArchive(dir, firstDay, lastDay) {
  const files = [];
  for (const day of (await readdir(dir)).sort()) {
    // A 24-hour comparison may need a capture from two UTC dates before the local target date.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < addDays(firstDay, -2) || day > lastDay) continue;
    for (const file of (await readdir(join(dir, day))).sort()) {
      if (file.endsWith('.json')) files.push(JSON.parse(await readFile(join(dir, day, file), 'utf8')));
    }
  }
  return files;
}

async function main(dir, output, reuse) {
  const now = Date.now();
  const today = localDay(now);
  if (reuse) {
    try {
      const response = await fetch(reuse, { signal: AbortSignal.timeout(8000), cache: 'no-store' });
      const previous = response.ok ? await response.json() : null;
      if (previous?.version === VERSION && previous.checkedOn === today) {
        await writeFile(output, JSON.stringify(previous) + '\n');
        return;
      }
    } catch { /* Tính mới nếu chưa đọc được kết quả lần trước. */ }
  }

  // OpenAQ đăng tệp 72 giờ sau khi ngày đo kết thúc theo giờ địa phương.
  const lastDay = addDays(today, -4);
  const firstDay = addDays(lastDay, -27);
  const snapshots = await readArchive(dir, firstDay, lastDay);
  const starts = snapshots.map(({ capturedAt }) => Date.parse(capturedAt)).filter(Number.isFinite);
  const earliest = starts.length ? localDay(Math.min(...starts)) : addDays(lastDay, 1);
  const from = earliest > firstDay ? earliest : firstDay;
  const observations = from <= lastDay
    ? await observationsFor(REFERENCE, new Date(from), new Date(lastDay), { minSamplesPerHour: MIN_REFERENCE_SAMPLES_PER_HOUR })
    : [];
  const rows = scoreForecastArchive(snapshots, observations, { firstDay: from, lastDay });
  const report = {
    version: VERSION, city: CITY.id, station: REFERENCE, checkedOn: today,
    through: lastDay, from: from <= lastDay ? from : null, snapshots: snapshots.length,
    minScored: MIN_SCORED, minDays: MIN_DAYS, rows,
  };
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log('Decision benchmark:', JSON.stringify(rows.map(({ hours, available, app }) =>
    ({ hours, available, scored: app.scored, days: app.days, rate: app.rate }))));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dir, output, reuse] = process.argv.slice(2);
  if (!dir || !output) throw new Error('Usage: node scripts/decision-benchmark.mjs <snapshots-dir> <output.json> [reuse-url]');
  await main(dir, output, reuse);
}
