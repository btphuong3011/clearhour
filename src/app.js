import { aqiFromConcentration, cigarettesPerDay, combinedAqi, LEVELS, levelForAqi, levelForPm25, nowcast, WHO_PM25_24H } from './aqi.js';
import { fetchAirQuality, fetchSample } from './api.js';
import { downloadIcs, googleCalendarUrl, localToUtc } from './calendar.js';
import { renderChart } from './chart.js';
import { CITIES } from './cities.js';
import { el, int, num } from './format.js';
import {
  ACTIVITIES,
  candidateStarts,
  compareWithPlan,
  dailyMean,
  DURATIONS,
  evaluateSlot,
  findBestWindows,
  ORG_PRESETS,
  PROFILES,
  SAME_ABS,
  SAME_REL,
  VENT_STATUSES,
  ventilationPlan,
  windowStats,
} from './planner.js';
import { MOOD, renderScene } from './scene.js';
import { buildStory, openStory } from './story.js';
import { ageText, compareWithModel, fetchStations, nearestStation, toLocalTime } from './stations.js';
import { addDays, datePart, dayLabel, formatClock, friendlyClock, hourOf, parseClock, shortDate, weekday } from './time.js';

const $ = (id) => document.getElementById(id);

// localStorage chỉ dùng cho tiện ích cá nhân; mọi lỗi truy cập đều bỏ qua.
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`clearhour:${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`clearhour:${key}`, JSON.stringify(value));
    } catch {
      /* bỏ qua */
    }
  },
};

const SCOPES = [
  { id: 'today', label: 'Hôm nay' },
  { id: 'tomorrow', label: 'Ngày mai' },
  { id: 'all', label: '3 ngày tới' },
];
const ORG_TYPES = [
  { id: 'school', label: 'Trường học' },
  { id: 'business', label: 'Doanh nghiệp' },
];
const CHART_RANGES = [
  { id: 'day', label: 'Trong ngày' },
  { id: 'all', label: '72 giờ' },
];
const STATUS_ICON = { ok: '✅', caution: '⚠️', stop: '⛔' };
// Nhân vật trong cảnh minh họa, theo hoạt động đang chọn
const FIGURE = { run: '🏃', cycle: '🚴', walk: '🚶', moto: '🛵', work: '👷' };
// Biểu cảm đi kèm mỗi mức, để hiểu ngay mà không cần đọc số
const FACE = { good: '😊', moderate: '🙂', poor: '😐', unhealthy: '😷', 'very-unhealthy': '😫', hazardous: '⚠️' };
const DEFAULT_FREE = '5-22';

const params = new URLSearchParams(location.search);
const pick = (value, list, fallback) => (list.some((x) => x.id === value) ? value : fallback);

/** "5-7,17-21" -> [{ from: 5, to: 7 }, { from: 17, to: 21 }] */
function parseFree(text) {
  const ranges = (text ?? '')
    .split(',')
    .map((part) => {
      const [from, to] = part.split('-').map(Number);
      return { from, to };
    })
    .filter((r) => Number.isInteger(r.from) && Number.isInteger(r.to) && r.from >= 0 && r.to <= 24 && r.from < r.to);
  return ranges.length ? ranges.slice(0, 3) : null;
}

/** "1.7" -> 07:00 ngày mai (số ngày tính từ hôm nay, rồi tới giờ) */
function parsePlan(text) {
  const m = /^([0-2])\.(\d{1,2})$/.exec(text ?? '');
  return m && Number(m[2]) < 24 ? { day: Number(m[1]), hour: Number(m[2]) } : null;
}

const state = {
  cityId: pick(params.get('city') ?? store.get('city', 'hanoi'), CITIES, 'hanoi'),
  myPlace: null,
  profile: pick(params.get('profile') ?? store.get('profile', 'adult'), PROFILES, 'adult'),
  activity: pick(params.get('activity') ?? 'run', ACTIVITIES, 'run'),
  hours: DURATIONS.includes(Number(params.get('dur'))) ? Number(params.get('dur')) : 1,
  scope: pick(params.get('scope'), SCOPES, 'today'),
  scopeFromUrl: params.has('scope'),
  free: parseFree(params.get('free')) ?? parseFree(DEFAULT_FREE),
  planFromUrl: parsePlan(params.get('plan')),
  planned: null, // chỉ số giờ bắt đầu của "giờ bạn định đi"
  selected: null, // khung người dùng bấm "Chọn"; null = theo đề xuất của app
  chartRange: 'day',
  heroHour: null, // chỉ số giờ đang xem trên cảnh đầu trang
  heroIndices: [],
  optionsOpen: false,
  orgType: pick(params.get('org'), ORG_TYPES, 'school'),
  slots: store.get('slots', null) ?? {
    school: structuredClone(ORG_PRESETS.school.slots),
    business: structuredClone(ORG_PRESETS.business.slots),
  },
  series: null,
  stations: [],
  // Kết quả tính của lần render gần nhất, dùng chung cho biểu đồ
  best: [],
  mine: null,
  chosen: null,
};

// Màu của 3 trạng thái cửa sổ lấy theo mức VN_AQI tương ứng (Tốt / Trung bình / Kém trở lên).
const VENT_COLORS = { open: LEVELS[0].display, brief: LEVELS[1].display, closed: LEVELS[2].display };

// ---------- Điều khiển dùng chung ----------

function radioGroup(container, items, current, onPick, { chip = false } = {}) {
  container.replaceChildren(
    ...items.map((item) =>
      el(
        'button',
        {
          type: 'button',
          role: 'radio',
          class: chip ? 'chip' : null,
          'aria-checked': String(item.id === current),
          onclick: () => onPick(item.id),
        },
        item.icon ? el('span', { 'aria-hidden': 'true' }, item.icon) : null,
        item.short ?? item.label,
      ),
    ),
  );
}

function hourSelect(value, from, to, label, onchange) {
  return el(
    'select',
    { 'aria-label': label, onchange },
    ...Array.from({ length: to - from + 1 }, (_, k) => from + k).map((h) => el('option', { value: h, selected: h === value }, friendlyClock(h))),
  );
}

function levelPill(level, extra = '') {
  return el('span', { class: `pill ${extra}`, style: { background: level.display, color: level.ink } }, `${FACE[level.id]} ${level.label}`);
}

const isSample = () => state.series.source === 'sample';
const activity = () => ACTIVITIES.find((a) => a.id === state.activity);
const profileOf = () => PROFILES.find((p) => p.id === state.profile);

function place() {
  return state.myPlace ?? CITIES.find((c) => c.id === state.cityId);
}

function placeName() {
  return isSample() ? 'Hà Nội' : place().name;
}

function todayStr() {
  return datePart(state.series.times[state.series.nowIndex]);
}

/** "Hôm nay / Ngày mai" với dữ liệu trực tiếp; ngày cụ thể khi đang xem dữ liệu mẫu để không ai hiểu nhầm. */
function dayName(dateStr) {
  return isSample() ? `${weekday(dateStr)} ${shortDate(dateStr)}` : dayLabel(dateStr, todayStr());
}

function dayWithDate(dateStr) {
  return isSample() ? dayName(dateStr) : `${dayName(dateStr)} ${shortDate(dateStr)}`;
}

/** "hôm nay", "ngày mai", hoặc thứ trong tuần; ngày cụ thể khi đang xem dữ liệu mẫu. */
function dayPhrase(dateStr) {
  if (isSample()) return dayName(dateStr);
  const d = dayLabel(dateStr, todayStr());
  return d === 'Hôm nay' || d === 'Ngày mai' ? d.toLowerCase() : d;
}

function windowLabel(w) {
  const t = state.series.times[w.start];
  const h = hourOf(t);
  const time = friendlyClock(h);
  return {
    day: dayName(datePart(t)),
    range: `${formatClock(h)}–${formatClock(h + w.hours)}`,
    time,
    when: `${time} ${dayPhrase(datePart(t))}`,
  };
}

const durationText = (hours) => (hours < 1 ? '30 phút' : `${hours} tiếng`);

/** Nhãn có ngày tháng cụ thể, dùng cho nội dung gửi đi (người nhận đọc vào lúc khác). */
function absoluteLabel(w) {
  const d = datePart(state.series.times[w.start]);
  return `${weekday(d)} ${shortDate(d)}, ${windowLabel(w).range}`;
}

function plannerOpts(scope = state.scope) {
  return { scope, ranges: state.free, hours: state.hours, ventilation: activity().ventilation };
}

function calendarEvent(w) {
  const s = state.series;
  const act = activity();
  const startLocal = s.times[w.start];
  const start = localToUtc(startLocal, s.utcOffsetSeconds);
  return {
    uid: `${startLocal}-${act.id}@clearhour`,
    title: `${act.icon} ${act.short} – giờ ít bụi mịn`,
    description:
      `PM2.5 dự báo trung bình ${num(w.mean)} µg/m³ (${levelForAqi(w.aqi).label}).\n` +
      `Gợi ý từ ClearHour: ${location.origin}${location.pathname}\n` +
      'Dự báo mang tính tham khảo, hãy xem lại trước khi ra ngoài.',
    location: placeName(),
    start,
    end: new Date(start.getTime() + w.hours * 3600e3),
    fileName: `clearhour-${act.id}-${startLocal.slice(0, 13).replace('T', '-')}h.ics`,
  };
}

/** Tin nhắn rủ nhóm: ngày giờ cụ thể, mức bụi dự báo, thời điểm dự báo và link mở lại đúng lựa chọn. */
function shareMessage(w, mine) {
  const s = state.series;
  const act = activity();
  const now = s.times[s.nowIndex];
  let line = `Bụi mịn PM2.5 dự báo khoảng ${num(w.mean)} µg/m³ (${levelForAqi(w.aqi).label})`;
  if (mine && compareWithPlan(mine, w).relation === 'better') {
    line += `, thấp hơn ${compareWithPlan(mine, w).pct}% so với ${absoluteLabel(mine)}`;
  }
  return [
    `${act.icon} ${act.short}: ${absoluteLabel(w)} tại ${placeName()}.`,
    `${line}.`,
    `Dự báo lúc ${now.slice(11, 16)} ${shortDate(datePart(now))}, có thể thay đổi. Xem lại trước khi đi: ${shareUrl()}`,
  ].join('\n');
}

async function copyText(text, status, onFail) {
  try {
    await navigator.clipboard.writeText(text);
    status.textContent = 'Đã sao chép ✓';
  } catch {
    onFail();
    status.textContent = 'Đã bôi đen nội dung, nhấn Ctrl+C để sao chép';
  }
  setTimeout(() => (status.textContent = ''), 4000);
}

function selectContents(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function stateParams() {
  const p = new URLSearchParams();
  if (!state.myPlace) p.set('city', state.cityId);
  p.set('profile', state.profile);
  p.set('activity', state.activity);
  p.set('dur', state.hours);
  p.set('scope', state.scope);
  const free = state.free.map((r) => `${r.from}-${r.to}`).join(',');
  if (free !== DEFAULT_FREE) p.set('free', free);
  if (state.planned != null && state.series) {
    const t = state.series.times[state.planned];
    const day = Math.round((Date.parse(datePart(t)) - Date.parse(todayStr())) / 86400e3);
    p.set('plan', `${day}.${hourOf(t)}`);
  }
  return p;
}

function syncUrl() {
  history.replaceState(null, '', `${location.pathname}?${stateParams()}${location.hash}`);
}

function shareUrl() {
  return `${location.origin}${location.pathname}?${stateParams()}`;
}

// ---------- Tải dữ liệu ----------

async function load() {
  const main = $('app');
  main.classList.add('is-loading');
  const banner = $('banner');
  banner.hidden = true;
  const p = place();
  try {
    state.series = await fetchAirQuality(p.lat, p.lon);
  } catch (err) {
    state.series = await fetchSample();
    const t = state.series.times[state.series.nowIndex];
    banner.textContent = `Không tải được dữ liệu trực tiếp (${err.message || 'lỗi mạng'}). Đang hiển thị dữ liệu mẫu của Hà Nội lúc ${t.slice(11, 16)} ${shortDate(datePart(t))}/${t.slice(0, 4)}.`;
    banner.hidden = false;
  }
  const s = state.series;
  if (!state.scopeFromUrl && state.scope === 'today' && !findBestWindows(s, plannerOpts('today')).best.length) {
    state.scope = 'tomorrow';
  }
  // Giờ định đi trong link chia sẻ được ghi theo "ngày thứ mấy kể từ hôm nay + giờ"
  if (state.planFromUrl) {
    const { day, hour } = state.planFromUrl;
    state.planFromUrl = null;
    const idx = s.times.indexOf(`${addDays(todayStr(), day)}T${String(hour).padStart(2, '0')}:00`);
    if (idx >= s.nowIndex) state.planned = idx;
  }
  state.selected = null;
  main.classList.remove('is-loading');
  renderAll();
}

// ---------- Render ----------

function renderAll() {
  if (!state.series) return;
  renderMeta();
  renderNow();
  renderPlanner();
  renderHero();
  if ($('chart-fold').open) renderChartSection();
  renderVentilation();
  $('story-open').hidden = !buildStory(state.series);
  renderOrg();
  syncUrl();
}

function renderMeta() {
  const s = state.series;
  const now = s.times[s.nowIndex];
  const last = s.times[s.times.length - 1];
  $('updated').textContent = isSample()
    ? 'Dữ liệu mẫu'
    : `Dữ liệu lúc ${now.slice(11, 16)} ${shortDate(datePart(now))} · dự báo đến ${weekday(datePart(last))} ${shortDate(datePart(last))}`;
  $('now-place').textContent = isSample()
    ? `Hà Nội (mẫu) · ${now.slice(11, 16)} ${shortDate(datePart(now))}/${now.slice(0, 4)}`
    : `${place().name} · ${now.slice(11, 16)}`;
}

/** Trạm đo gần nhất kèm dự báo của mô hình tại đúng giờ đo (số đo có thể cũ vài giờ). */
function stationInfo() {
  const s = state.series;
  if (isSample() || !state.stations.length) return null;
  const p = place();
  const st = nearestStation(state.stations, p.lat, p.lon);
  if (!st) return null;
  const local = toLocalTime(st.time, s.utcOffsetSeconds);
  const idx = s.times.indexOf(`${local.slice(0, 13)}:00`);
  const model = s.pm25[idx >= 0 ? idx : s.nowIndex];
  const ageMs = Date.now() - Date.parse(st.time);
  return { st, local, model, ageMs, age: ageText(ageMs), match: compareWithModel(st.pm25, model), level: levelForPm25(st.pm25) };
}

/** Một câu bằng lời thường cho biết gợi ý đang dựa trên dữ liệu đáng tin đến đâu (số liệu nằm trong phần chi tiết). */
function dataStatus(info) {
  const s = state.series;
  if (isSample()) {
    const t = s.times[s.nowIndex];
    return { tone: 'warn', text: `Đang xem dữ liệu mẫu ngày ${shortDate(datePart(t))}/${t.slice(0, 4)}, không phải dự báo hiện tại.` };
  }
  if (!info) return { tone: 'info', text: 'Gần bạn chưa có trạm đo để đối chiếu, gợi ý dựa trên dự báo.' };
  // Số đo trạm có thể đã cũ vài giờ nên luôn nói rõ đo lúc nào
  const at = `Lúc ${info.local.slice(11, 16)}, trạm đo gần đây`;
  if (info.match === 'agree') return { tone: 'ok', text: `${at} cho kết quả gần giống dự báo.` };
  if (info.match === 'station-higher') {
    return { tone: 'warn', text: `${at} thấy nhiều bụi hơn dự báo. Nếu ra ngoài, nên mang theo khẩu trang.` };
  }
  return { tone: 'warn', text: `${at} thấy ít bụi hơn dự báo. Chưa rõ bên nào đúng hơn.` };
}

function renderNow() {
  const s = state.series;
  const back = (arr) => Array.from({ length: 12 }, (_, k) => arr[s.nowIndex - k] ?? null);
  const aqi = combinedAqi({ pm2_5: nowcast(back(s.pm25)), pm10: nowcast(back(s.pm10)) });
  const modelLevel = levelForAqi(aqi);
  $('now-aqi').textContent = int(aqi);
  $('now-pm25').textContent = num(s.current.pm25 ?? s.pm25[s.nowIndex]);

  // Các phép so sánh theo ngày nằm trong phần số liệu chi tiết
  const mean = dailyMean(s, todayStr());
  const ratio = mean / WHO_PM25_24H;
  $('now-daymean').textContent = num(mean);
  $('now-who').textContent = ratio > 1 ? `gấp ${num(ratio)} lần` : 'trong mức khuyến nghị';
  $('now-cig').textContent = num(cigarettesPerDay(mean));

  const info = stationInfo();
  renderStation(info);

  // Trạm đo còn mới (dưới 3 giờ) và đang xấu hơn dự báo thì lời khuyên theo trạm đo cho an toàn.
  const profile = profileOf();
  const stationWorse = Boolean(info) && info.ageMs <= 3 * 3600e3 && LEVELS.indexOf(info.level) > LEVELS.indexOf(modelLevel);
  const level = stationWorse ? info.level : modelLevel;
  $('now-face').textContent = level ? FACE[level.id] : '🙂';
  $('now-face').style.setProperty('--lvl', level?.display ?? 'var(--line)');
  $('now-level').textContent = level ? `Không khí: ${level.label}` : '–';
  $('now-advice').replaceChildren(
    el('strong', {}, `${profile.short}: `),
    level ? level.advice[profile.sensitive ? 'sensitive' : 'normal'] : '',
    stationWorse ? ' (Đánh giá theo trạm đo gần đây, đang xấu hơn dự báo.)' : '',
  );

  const note = $('now-station');
  note.hidden = !info;
  if (info) {
    note.textContent = `📍 Trạm đo gần nhất (${info.st.name}, cách ${num(info.st.km)} km) đo được mức «${info.level.label}» lúc ${info.local.slice(11, 16)}.`;
  }
}

function renderStation(info) {
  const row = $('station-row');
  row.hidden = isSample() || !state.stations.length;
  if (row.hidden) return;
  if (!info) {
    $('station-meta').textContent = 'Không có trạm nào đo trong 12 giờ qua, bán kính 30 km';
    $('station-val').replaceChildren('–');
    return;
  }
  const { st, local } = info;
  const when = datePart(local) === todayStr() ? local.slice(11, 16) : `${local.slice(11, 16)} ${shortDate(datePart(local))}`;
  $('station-meta').textContent =
    `${st.name} · cách ${num(st.km)} km · đo lúc ${when} (${info.age})` + (st.isMonitor ? '' : ' · cảm biến giá rẻ');
  $('station-val').replaceChildren(
    num(st.pm25),
    ' ',
    el('small', {}, 'µg/m³'),
    el('small', { class: 'sub' }, `mức ${info.level.label} · mô hình lúc đó: ${num(info.model)}`),
  );
}

function renderFreeRanges() {
  const changed = () => {
    state.selected = null;
    renderAll();
  };
  $('free-ranges').replaceChildren(
    ...state.free.map((r, idx) =>
      el(
        'span',
        { class: 'free__range' },
        hourSelect(r.from, 0, 23, 'Rảnh từ', (e) => {
          r.from = Number(e.target.value);
          if (r.to <= r.from) r.to = Math.min(24, r.from + 1);
          changed();
        }),
        el('span', { 'aria-hidden': 'true' }, '–'),
        hourSelect(r.to, 1, 24, 'Rảnh đến', (e) => {
          r.to = Number(e.target.value);
          if (r.to <= r.from) r.from = Math.max(0, r.to - 1);
          changed();
        }),
        state.free.length > 1
          ? el(
              'button',
              {
                type: 'button',
                class: 'btn btn--icon',
                'aria-label': `Xóa khoảng rảnh ${formatClock(r.from)}–${formatClock(r.to)}`,
                onclick: () => {
                  state.free.splice(idx, 1);
                  changed();
                },
              },
              '✕',
            )
          : null,
      ),
    ),
    state.free.length < 3
      ? el(
          'button',
          {
            type: 'button',
            class: 'btn btn--ghost btn--xs',
            onclick: () => {
              // Lần đầu thêm: tách "cả ngày" thành hai khoảng quen thuộc, trước và sau giờ học / giờ làm
              if (state.free.map((r) => `${r.from}-${r.to}`).join() === DEFAULT_FREE) state.free = parseFree('5-7,17-21');
              else state.free.push({ from: 12, to: 13 });
              changed();
            },
          },
          '+ Thêm khoảng rảnh',
        )
      : null,
  );
}

function renderPlanner() {
  const s = state.series;
  const act = activity();
  const profile = profileOf();
  const pickAndRender = (key) => (id) => {
    state[key] = id;
    state.selected = null;
    renderAll();
  };

  radioGroup($('activities'), ACTIVITIES, state.activity, pickAndRender('activity'), { chip: true });
  radioGroup(
    $('durations'),
    DURATIONS.map((d) => ({ id: d, label: d < 1 ? '30 phút' : `${d} giờ` })),
    state.hours,
    pickAndRender('hours'),
  );
  radioGroup($('scopes'), SCOPES, state.scope, pickAndRender('scope'));
  renderFreeRanges();

  const { best, worst } = findBestWindows(s, plannerOpts(), 3);

  // "Giờ bạn định đi" được chọn tự do trong các ngày đang xét, kể cả ngoài khoảng rảnh
  const choices = candidateStarts(s, { scope: state.scope, ranges: [{ from: 0, to: 24 }], hours: state.hours });
  if (!choices.includes(state.planned)) state.planned = null;
  $('planned').replaceChildren(
    el('option', { value: '' }, '— Chưa chọn —'),
    ...choices.map((i) => {
      const { day, time } = windowLabel({ start: i, hours: state.hours });
      return el('option', { value: i, selected: i === state.planned }, `${day} · ${time}`);
    }),
  );
  const mine = state.planned != null ? windowStats(s.pm25, state.planned, state.hours, act.ventilation) : null;

  // Đem ra so: giờ định đi và các khung đề xuất. Lúc rảnh nào nhiều bụi hơn hẳn giờ định đi thì không đề xuất.
  const others = best.filter((w) => !mine || w.start !== mine.start);
  const suggestions = mine ? others.filter((w) => compareWithPlan(mine, w).relation !== 'worse') : others;
  const top = suggestions[0] ?? null;
  const cmp = mine && top ? compareWithPlan(mine, top) : null;
  const shouldSwitch = cmp?.relation === 'better';
  const options = [...(mine ? [mine] : []), ...suggestions];
  if (!options.some((w) => w.start === state.selected)) state.selected = null;
  const chosen = options.find((w) => w.start === state.selected) ?? (mine && !shouldSwitch ? mine : top);
  Object.assign(state, { best: suggestions, mine, chosen });

  const free = state.free.map((r) => `${friendlyClock(r.from)}–${friendlyClock(r.to)}`).join(', ');
  $('plan-summary').textContent = `Tùy chỉnh: ${act.icon} ${act.short} · ${durationText(state.hours)} · rảnh ${free}`;

  const out = [];
  if (!options.length) {
    out.push(el('p', { class: 'empty' }, 'Không còn giờ nào phù hợp trong những lúc bạn rảnh. Thử chọn ngày khác, hoặc mở phần Tùy chỉnh để thêm giờ rảnh.'));
  } else {
    out.push(verdictCard({ mine, top, cmp, shouldSwitch, worst, hasOthers: others.length > 0, chosen }));
    const level = levelForAqi(chosen.aqi);
    if (chosen.aqi > (profile.sensitive ? 100 : 150)) {
      out.push(el('p', { class: 'warn' }, `${FACE[level.id]} Giờ đã chọn vẫn ở mức ${level.label}. ${level.advice[profile.sensitive ? 'sensitive' : 'normal']}`));
    }
  }

  const info = stationInfo();
  const status = dataStatus(info);
  out.push(
    el(
      'p',
      { class: `status status--${status.tone}` },
      el('span', { class: 'status__icon', 'aria-hidden': 'true' }, status.tone === 'ok' ? '✓' : status.tone === 'warn' ? '!' : 'i'),
      el('span', {}, status.text),
    ),
  );

  if (options.length > 1) {
    out.push(
      el(
        'details',
        { class: 'more', open: state.optionsOpen, ontoggle: (e) => (state.optionsOpen = e.target.open) },
        el('summary', {}, `Xem các giờ khác (${options.length})`),
        optionList({ options, mine, suggestions, chosen }),
      ),
    );
  }

  // Mọi con số gom vào một chỗ, ai cần mới mở ra
  const rows = [];
  const line = (label, w) => rows.push(el('li', {}, `${label} (${windowLabel(w).range}): PM2.5 trung bình dự báo ${num(w.mean)} µg/m³.`));
  if (mine) line('Giờ bạn định đi', mine);
  if (chosen && chosen.start !== mine?.start) line('Giờ đã chọn', chosen);
  if (worst && worst.start !== chosen?.start) line('Giờ nhiều bụi nhất trong lúc rảnh', worst);
  if (info) {
    rows.push(el('li', {}, `Trạm ${info.st.name} (cách ${num(info.st.km)} km) đo ${num(info.st.pm25)} µg/m³ lúc ${info.local.slice(11, 16)} (${info.age}); mô hình dự báo lúc đó ${num(info.model)} µg/m³.`));
  }
  rows.push(el('li', {}, `Phần trăm tính trên PM2.5 trung bình dự báo của cả khung giờ. Hai giờ chênh dưới ${SAME_REL * 100}% hoặc dưới ${SAME_ABS} µg/m³ được coi là gần như nhau.`));
  if (chosen && profile.id === 'adult') {
    rows.push(el('li', {}, `Ở giờ đã chọn, người lớn hít vào khoảng ${int(chosen.dose)} µg bụi mịn (cường độ ${act.intensity}, ~${num(act.ventilation)} m³ không khí/giờ).`));
  } else if (chosen) {
    rows.push(el('li', {}, `Hồ sơ «${profile.short}» chỉ đổi lời khuyên và ngưỡng cảnh báo; số liệu bụi giữ nguyên.`));
  }
  out.push(el('details', { class: 'more' }, el('summary', {}, 'Chi tiết số liệu'), el('ul', { class: 'facts' }, ...rows)));
  $('results').replaceChildren(...out);
}

/** Một bên của phép so sánh: cảnh trời minh họa đúng giờ đó, kèm giờ và mức không khí bằng lời. */
function sceneCard(tag, w, extraClass = '') {
  const { day, time, range } = windowLabel(w);
  const level = levelForAqi(w.aqi);
  const art = el('div', { class: 'scene-card__art' });
  art.append(
    renderScene({
      width: 480,
      height: 220,
      hour: hourOf(state.series.times[w.start]),
      pm25: w.mean,
      figure: FIGURE[state.activity],
      figureX: 0.5,
      figureScale: 0.3,
      seed: 23,
      id: `m${w.start}`,
      label: `Minh họa bầu trời ${day.toLowerCase()} ${range}, không khí mức ${level.label}`,
    }),
  );
  return el(
    'figure',
    { class: `scene-card ${extraClass}` },
    art,
    el(
      'figcaption',
      {},
      el('span', { class: 'scene-card__tag' }, tag),
      el('span', { class: 'scene-card__time' }, time),
      el('span', { class: 'scene-card__day' }, `${day} · ${durationText(w.hours)}`),
      el('span', { class: 'scene-card__pm' }, levelPill(level)),
    ),
  );
}

function verdictCard({ mine, top, cmp, shouldSwitch, hasOthers, chosen }) {
  let title;
  let sub;
  let duel;
  if (mine && shouldSwitch) {
    title = `Nên dời sang ${windowLabel(top).when}`;
    sub = ['Ít bụi hơn khoảng ', el('strong', {}, `${cmp.pct}%`), ' so với giờ bạn định đi.'];
    duel = [sceneCard('Giờ bạn định đi', mine), el('span', { class: 'duel__arrow', 'aria-hidden': 'true' }, '→'), sceneCard('Nên đi lúc', top, 'scene-card--to')];
  } else if (mine) {
    title = `Cứ giữ giờ cũ: ${windowLabel(mine).when}`;
    sub = [top ? 'Những lúc rảnh khác cũng không ít bụi hơn bao nhiêu, không cần đổi.' : hasOthers ? 'Những lúc rảnh khác đều nhiều bụi hơn giờ này.' : 'Không có lúc rảnh nào khác để so sánh.'];
    duel = [sceneCard('Giờ bạn định đi', mine, 'scene-card--to')];
  } else {
    title = `Lúc ít bụi nhất: ${windowLabel(top).when}`;
    sub = ['Chọn «Giờ bạn định đi» ở trên để biết có nên đổi giờ không.'];
    duel = [sceneCard('Nên đi lúc', top, 'scene-card--to')];
  }
  return el(
    'div',
    { class: 'verdict-card' },
    el('p', { class: 'verdict-card__title' }, title),
    el('p', { class: 'verdict-card__sub' }, ...sub),
    el('div', { class: `duel${duel.length === 1 ? ' duel--single' : ''}` }, ...duel),
    chosenBar(chosen, mine),
  );
}

function optionList({ options, mine, suggestions, chosen }) {
  return el(
    'ul',
    { class: 'options', 'aria-label': 'Các giờ để so sánh' },
    ...options.map((w) => {
      const { day, time } = windowLabel(w);
      const isMine = mine?.start === w.start;
      const isChosen = chosen.start === w.start;
      const level = levelForAqi(w.aqi);
      let note = isMine ? 'Giờ bạn định đi' : '';
      if (mine && !isMine) {
        const c = compareWithPlan(mine, w);
        note = c.relation === 'same' ? 'Gần như giờ bạn định đi' : `Ít bụi hơn ${c.pct}%`;
      }
      return el(
        'li',
        { class: `option${isChosen ? ' option--chosen' : ''}` },
        isMine
          ? el('span', { class: 'option__mark option__mark--plan', title: 'Giờ bạn định đi' })
          : el('span', { class: 'option__mark', title: 'Giờ nên đi' }, suggestions.indexOf(w) + 1),
        el(
          'span',
          { class: 'option__main' },
          el('span', { class: 'option__time' }, `${time} · ${day}`),
          el('span', { class: 'option__detail' }, `${FACE[level.id]} ${level.label}${note ? ` · ${note}` : ''}`),
        ),
        el(
          'button',
          {
            type: 'button',
            class: `btn btn--sm ${isChosen ? '' : 'btn--ghost'}`,
            'aria-pressed': String(isChosen),
            'aria-label': `Chọn ${time} ${day.toLowerCase()}`,
            onclick: () => {
              state.selected = w.start;
              renderAll();
            },
          },
          isChosen ? '✓ Đã chọn' : 'Chọn',
        ),
      );
    }),
  );
}

/** Hành động sau quyết định: đưa giờ đã chọn vào lịch hoặc gửi cho bạn bè. */
function chosenBar(chosen, mine) {
  const head = el('p', { class: 'chosen__label' }, 'Đã chọn: ', el('strong', {}, windowLabel(chosen).when));
  if (isSample()) {
    return el('div', { class: 'chosen' }, head, el('p', { class: 'muted small' }, 'Đây là lịch minh họa từ dữ liệu mẫu nên không thêm vào lịch hay gửi đi được.'));
  }
  const ev = calendarEvent(chosen);
  const status = el('span', { class: 'muted small', 'aria-live': 'polite' });
  const preview = el('pre', { class: 'chosen__text', hidden: true }, shareMessage(chosen, mine));
  return el(
    'div',
    { class: 'chosen' },
    head,
    el(
      'div',
      { class: 'chosen__actions' },
      el('a', { class: 'btn', href: googleCalendarUrl(ev), target: '_blank', rel: 'noopener' }, '📅 Thêm vào lịch'),
      el(
        'button',
        {
          type: 'button',
          class: 'btn btn--ghost',
          onclick: () =>
            copyText(preview.textContent, status, () => {
              preview.hidden = false;
              selectContents(preview);
            }),
        },
        '💬 Gửi cho bạn bè',
      ),
      el('button', { type: 'button', class: 'btn btn--link', onclick: () => downloadIcs(ev, ev.fileName) }, 'Tải tệp lịch (.ics)'),
      status,
    ),
    preview,
  );
}

// ---------- Cảnh đầu trang ----------

function renderHero() {
  const s = state.series;
  const focus = state.chosen?.start ?? s.nowIndex;
  const day = datePart(s.times[focus]);
  const idx = s.times.map((t, i) => (datePart(t) === day && s.pm25[i] != null ? i : -1)).filter((i) => i >= 0);
  state.heroIndices = idx;
  state.heroHour = idx.includes(focus) ? focus : idx[0];

  const slider = $('hero-hour');
  slider.max = idx.length - 1;
  slider.value = idx.indexOf(state.heroHour);
  // Thanh trượt tô màu theo mức bụi của từng giờ, đọc được cả ngày chỉ với một cái liếc
  const stops = idx.map((i, k) => {
    const color = levelForPm25(s.pm25[i])?.display ?? '#cccccc';
    return `${color} ${((k / idx.length) * 100).toFixed(2)}% ${(((k + 1) / idx.length) * 100).toFixed(2)}%`;
  });
  slider.style.setProperty('--track', `linear-gradient(to right, ${stops.join(', ')})`);

  const mark = (i, cls, text, title) => {
    const k = idx.indexOf(i);
    if (k < 0) return null;
    return el('span', { class: `hero__mark ${cls}`, style: { left: `${((k + 0.5) / idx.length) * 100}%` }, title }, text);
  };
  $('hero-marks').replaceChildren(
    ...[
      idx.includes(s.nowIndex) ? mark(s.nowIndex, 'hero__mark--now', '', 'Bây giờ') : null,
      state.mine ? mark(state.mine.start, 'hero__mark--plan', '', 'Giờ bạn định đi') : null,
      ...state.best.map((w, n) => mark(w.start, '', String(n + 1), `Giờ nên đi ${n + 1}`)),
    ].filter(Boolean),
  );
  drawHeroScene();
}

function drawHeroScene() {
  const s = state.series;
  const i = state.heroHour;
  const t = s.times[i];
  const pm = s.pm25[i];
  const level = levelForPm25(pm);
  const day = dayName(datePart(t));
  const host = $('hero-scene');
  host.replaceChildren(
    renderScene({
      width: 1200,
      height: 360,
      hour: hourOf(t),
      pm25: pm,
      figure: FIGURE[state.activity],
      bubble: level ? MOOD[level.id] : null,
      figureX: host.clientWidth < 700 ? 0.5 : 0.68,
      id: 'hero',
      label: `Minh họa bầu trời ${placeName()} ${day.toLowerCase()} lúc ${t.slice(11, 16)}, PM2.5 dự báo ${num(pm)} µg/m³`,
    }),
  );
  const tags = [];
  if (i === s.nowIndex) tags.push('bây giờ');
  if (state.mine?.start === i) tags.push('giờ bạn định đi');
  const n = state.best.findIndex((w) => w.start === i);
  if (n >= 0) tags.push(`giờ nên đi ${n + 1}`);
  $('hero-caption').replaceChildren(
    el('strong', {}, `${day} · ${friendlyClock(hourOf(t))}`),
    level ? levelPill(level) : '',
    tags.length ? el('span', { class: 'hero__tags' }, tags.join(' · ')) : '',
  );
}

function renderVentilation() {
  const s = state.series;
  const profile = profileOf();
  const { slots, runs, best } = ventilationPlan(s, 24);
  const at = (i) => `${dayName(datePart(s.times[i]))} ${s.times[i].slice(11, 16)}`;

  // Gợi ý chính
  const head = [];
  if (best.length && best[0].mean <= VENT_STATUSES[1].max) {
    head.push(
      el('span', { class: 'vent__label' }, 'Giờ thông gió tốt nhất'),
      ...best.map((w, i) =>
        el(
          'span',
          { class: `vent__pick${i === 0 ? ' vent__pick--top' : ''}` },
          `${windowLabel(w).day} · ${windowLabel(w).time}`,
          el('small', {}, ` ${FACE[levelForAqi(w.aqi).id]}`),
        ),
      ),
    );
  } else {
    head.push(el('span', { class: 'vent__label' }, 'Bụi cao suốt 24 giờ tới: hạn chế mở cửa, ưu tiên máy lọc không khí.'));
  }
  $('vent-best').replaceChildren(...head);

  // Dải 24 giờ
  $('vent-strip').replaceChildren(
    ...slots.map((sl) =>
      el('span', {
        style: { background: VENT_COLORS[sl.status.id] },
        title: `${at(sl.index)} · PM2.5 ${num(sl.pm25)} µg/m³ · ${sl.status.label}`,
      }),
    ),
  );
  $('vent-strip').setAttribute('aria-label', `Trạng thái mở cửa sổ theo giờ trong ${slots.length} giờ tới`);
  $('vent-axis').replaceChildren(
    ...slots.map((sl, k) => {
      const h = hourOf(sl.time);
      const label = k === 0 ? 'Bây giờ' : k > 3 && h % 3 === 0 ? `${String(h).padStart(2, '0')}h` : '';
      return el('span', { class: h === 0 ? 'is-midnight' : null }, label);
    }),
  );
  $('vent-legend').replaceChildren(
    ...VENT_STATUSES.map((st) => el('li', {}, el('i', { style: { background: VENT_COLORS[st.id] } }), st.label)),
  );

  // Các đoạn liên tiếp, dạng chữ
  const runText = (r) => {
    const t0 = s.times[r.start];
    const t1 = s.times[r.end - 1];
    const d0 = dayName(datePart(t0)).toLowerCase();
    const d1 = dayName(datePart(t1)).toLowerCase();
    const from = formatClock(hourOf(t0));
    const to = formatClock(hourOf(t1) + 1);
    return d0 === d1 ? `${from}–${to} ${d0}` : `${from} ${d0} – ${to} ${d1}`;
  };
  $('vent-runs').replaceChildren(
    ...runs.slice(0, 6).map((r) =>
      el(
        'li',
        {},
        el('i', { style: { background: VENT_COLORS[r.status.id] }, 'aria-hidden': 'true' }),
        el('span', {}, el('strong', {}, r.status.label), ` · ${runText(r)}`),
      ),
    ),
  );

  $('vent-tip').textContent =
    (profile.sensitive ? `Nhà có ${profile.short.toLowerCase()}: chỉ nên mở cửa trong các giờ màu xanh. ` : '') +
    'Khi mở, mở hai cửa đối diện 10–15 phút để không khí lưu thông nhanh. Khi đóng, hạn chế đốt nhang và chiên rán, bật máy lọc có màng HEPA nếu có.';
}

function renderChartSection() {
  const s = state.series;
  radioGroup($('chart-range'), CHART_RANGES, state.chartRange, (id) => {
    state.chartRange = id;
    renderChartSection();
  });

  // "Trong ngày": cả ngày của khung đang chọn, để hai mốc cần so nằm gọn trong một màn hình
  const focus = datePart(s.times[state.chosen?.start ?? s.nowIndex]);
  let start = Math.max(0, s.nowIndex - 6);
  let end = Math.min(s.times.length, s.nowIndex + 72);
  if (state.chartRange === 'day') {
    start = s.times.findIndex((t) => datePart(t) === focus);
    end = start;
    while (end < s.times.length && datePart(s.times[end]) === focus) end++;
  }
  renderChart($('chart-scroll'), $('tooltip'), {
    series: s,
    start,
    end,
    windows: state.best.map((w, i) => ({ start: w.start, hours: w.hours, rank: i + 1 })),
    planned: state.mine,
    dayText: (d) => `${weekday(d)} ${shortDate(d)} · TB ngày ${num(dailyMean(s, d))}`,
  });
  $('chart-sub').textContent =
    (state.chartRange === 'day' ? `${dayWithDate(focus)}.` : '72 giờ tới.') + ' Cột tô màu theo mức VN_AQI của từng giờ; cột mờ là giờ đã qua.';

  const rows = [];
  for (let i = s.nowIndex; i < Math.min(s.times.length, s.nowIndex + 72); i++) {
    const t = s.times[i];
    const aqi = aqiFromConcentration(s.pm25[i], 'pm2_5');
    const level = levelForAqi(aqi);
    rows.push(
      el(
        'tr',
        {},
        el('td', {}, `${weekday(datePart(t))} ${shortDate(datePart(t))} ${t.slice(11, 16)}`),
        el('td', {}, num(s.pm25[i])),
        el('td', {}, num(s.pm10[i])),
        el('td', {}, int(aqi)),
        el('td', {}, level ? level.label : '–'),
      ),
    );
  }
  $('table').replaceChildren(
    el(
      'table',
      {},
      el(
        'thead',
        {},
        el('tr', {}, ...['Thời gian', 'PM2.5 (µg/m³)', 'PM10 (µg/m³)', 'VN_AQI (PM2.5)', 'Mức'].map((h) => el('th', { scope: 'col' }, h))),
      ),
      el('tbody', {}, rows),
    ),
  );

  $('grid-note').textContent =
    `«TB ngày» là PM2.5 trung bình 24 giờ theo dự báo; WHO khuyến nghị mức này không quá ${WHO_PM25_24H} µg/m³. ` +
    `Ô lưới mô hình gần nhất: ${num(s.gridLat)}°N, ${num(s.gridLon)}°E (CAMS toàn cầu, ~45 km). Giờ địa phương (${s.timezone}). ` +
    'Chỉ số theo từng giờ được quy đổi trực tiếp từ nồng độ dự báo, không dùng Nowcast như trạm quan trắc.';
}

function renderLegend() {
  $('legend').replaceChildren(
    ...LEVELS.map((l) => el('li', {}, el('i', { style: { background: l.display } }), l.label)),
    el('li', {}, el('i', { class: 'mark' }, '1'), 'Khung đề xuất'),
    el('li', {}, el('i', { class: 'mark mark--plan' }), 'Giờ bạn định đi'),
  );
}

// ---------- Lịch cố định (trường học, doanh nghiệp) ----------

function orgDays() {
  const today = todayStr();
  const lastDay = datePart(state.series.times[state.series.times.length - 1]);
  return [0, 1, 2].map((k) => addDays(today, k)).filter((d) => d <= lastDay);
}

function slotPassed(day, slot) {
  if (day !== todayStr()) return false;
  return parseClock(slot.to) <= hourOf(state.series.times[state.series.nowIndex]);
}

function renderOrg() {
  radioGroup($('org-types'), ORG_TYPES, state.orgType, (id) => {
    state.orgType = id;
    renderOrg();
  });
  renderSlots();
  renderOrgPlan();
}

function saveSlots() {
  store.set('slots', state.slots);
}

function renderSlots() {
  const slots = state.slots[state.orgType];
  $('slots').replaceChildren(
    ...slots.map((slot, idx) => {
      const update = (key) => (ev) => {
        slot[key] = ev.target.value || slot[key];
        if (parseClock(slot.to) <= parseClock(slot.from)) slot.to = formatClock(Math.min(24, parseClock(slot.from) + 1));
        saveSlots();
        renderOrgPlan();
      };
      return el(
        'tr',
        {},
        el('td', {}, el('input', { type: 'text', value: slot.name, 'aria-label': 'Tên hoạt động', onchange: update('name') })),
        el('td', {}, el('input', { type: 'time', value: slot.from, step: 900, 'aria-label': 'Bắt đầu', onchange: update('from') })),
        el('td', {}, el('input', { type: 'time', value: slot.to, step: 900, 'aria-label': 'Kết thúc', onchange: update('to') })),
        el(
          'td',
          {},
          el(
            'button',
            {
              type: 'button',
              class: 'btn btn--icon',
              'aria-label': `Xóa ${slot.name}`,
              onclick: () => {
                slots.splice(idx, 1);
                saveSlots();
                renderOrg();
              },
            },
            '✕',
          ),
        ),
      );
    }),
  );
}

function renderOrgPlan() {
  const s = state.series;
  const days = orgDays();
  const slots = state.slots[state.orgType];

  const head = el('tr', {}, el('th', { scope: 'col' }, 'Hoạt động'), ...days.map((d) => el('th', { scope: 'col' }, dayWithDate(d))));
  const body = slots.map((slot) =>
    el(
      'tr',
      {},
      el('th', { scope: 'row' }, el('div', {}, slot.name), el('div', { class: 'verdict__meta' }, `${slot.from}–${slot.to}`)),
      ...days.map((d) => {
        if (slotPassed(d, slot)) return el('td', { class: 'muted small' }, 'Đã qua');
        const v = evaluateSlot(s, d, slot, state.orgType);
        if (!v) return el('td', { class: 'muted small' }, 'Chưa có dữ liệu');
        return el(
          'td',
          {},
          el(
            'div',
            { class: `verdict verdict--${v.status}` },
            el('span', { class: 'verdict__head' }, el('span', { 'aria-hidden': 'true' }, STATUS_ICON[v.status]), v.text),
            el(
              'span',
              { class: 'verdict__meta', title: `PM2.5 cao nhất ${num(v.peak)}, trung bình ${num(v.mean)} µg/m³` },
              `${FACE[v.level.id]} Không khí ${v.level.label.toLowerCase()}`,
            ),
          ),
        );
      }),
    ),
  );
  $('org-grid').replaceChildren(el('table', {}, el('thead', {}, head), el('tbody', {}, body)));
  $('notice').textContent = buildNotice(days, slots);
}

function buildNotice(days, slots) {
  const s = state.series;
  const now = s.times[s.nowIndex];
  const lines = [
    state.orgType === 'school' ? 'Kính gửi quý phụ huynh và các em học sinh,' : 'Gửi anh chị em làm việc ngoài trời,',
    '',
    `📢 LỊCH HOẠT ĐỘNG NGOÀI TRỜI THEO DỰ BÁO BỤI MỊN – ${isSample() ? 'Hà Nội (dữ liệu mẫu)' : place().name}`,
    `(Cập nhật ${now.slice(11, 16)} ngày ${shortDate(datePart(now))})`,
  ];
  for (const d of days) {
    lines.push('', `${dayWithDate(d)}:`);
    for (const slot of slots) {
      if (slotPassed(d, slot)) continue;
      const v = evaluateSlot(s, d, slot, state.orgType);
      if (!v) continue;
      lines.push(`• ${slot.name} (${slot.from}–${slot.to}): ${STATUS_ICON[v.status]} ${v.text} – PM2.5 cao nhất ~${num(v.peak)} µg/m³ (${v.level.label})`);
    }
  }
  lines.push('', 'Nguồn: ClearHour – dự báo CAMS/Open-Meteo, chỉ số VN_AQI theo QĐ 1459/QĐ-TCMT. Thông tin mang tính tham khảo.');
  return lines.join('\n');
}

function copyNotice() {
  copyText($('notice').textContent, $('copy-status'), () => {
    $('notice').closest('details').open = true;
    selectContents($('notice'));
  });
}

// ---------- Câu chuyện ----------

function startStory() {
  openStory({
    series: state.series,
    place: placeName(),
    sample: isSample(),
    figure: '🏃',
    onFinish: () => {
      $('ca-nhan').scrollIntoView({ behavior: 'smooth' });
      $('planned').focus({ preventScroll: true });
    },
  });
}

// ---------- Khởi tạo ----------

function initControls() {
  const city = $('city');
  city.replaceChildren(...CITIES.map((c) => el('option', { value: c.id, selected: c.id === state.cityId }, c.name)));
  city.addEventListener('change', () => {
    if (city.value === 'me') return;
    state.cityId = city.value;
    state.myPlace = null;
    city.querySelector('option[value="me"]')?.remove();
    store.set('city', state.cityId);
    load();
  });

  $('locate').addEventListener('click', () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.myPlace = { name: 'Vị trí của bạn', lat: pos.coords.latitude, lon: pos.coords.longitude };
        if (!city.querySelector('option[value="me"]')) city.prepend(el('option', { value: 'me' }, '📍 Vị trí của bạn'));
        city.value = 'me';
        load();
      },
      (err) => {
        const banner = $('banner');
        banner.textContent = `Không lấy được vị trí của bạn (${err.message}). Hãy chọn thành phố trong danh sách.`;
        banner.hidden = false;
      },
      { timeout: 10000, maximumAge: 600000 },
    );
  });

  const profile = $('profile');
  profile.replaceChildren(...PROFILES.map((p) => el('option', { value: p.id, selected: p.id === state.profile }, p.label)));
  profile.addEventListener('change', () => {
    state.profile = profile.value;
    store.set('profile', state.profile);
    renderAll();
  });

  $('planned').addEventListener('change', (e) => {
    state.planned = e.target.value === '' ? null : Number(e.target.value);
    state.selected = null;
    renderAll();
  });

  $('add-slot').addEventListener('click', () => {
    state.slots[state.orgType].push({ name: 'Hoạt động mới', from: '08:00', to: '09:00' });
    saveSlots();
    renderOrg();
  });
  $('copy-notice').addEventListener('click', copyNotice);

  $('hero-hour').addEventListener('input', (e) => {
    state.heroHour = state.heroIndices[Number(e.target.value)] ?? state.heroHour;
    drawHeroScene();
  });

  $('chart-fold').addEventListener('toggle', (e) => {
    if (e.target.open && state.series) renderChartSection();
  });

  $('story-open').addEventListener('click', startStory);

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!state.series) return;
      if ($('chart-fold').open) renderChartSection();
      drawHeroScene();
    }, 150);
  });

  renderLegend();
}

initControls();
// Link có #cau-chuyen thì mở câu chuyện ngay khi có dữ liệu (tiện khi thuyết trình)
load().then(() => {
  if (location.hash === '#cau-chuyen' && state.series && buildStory(state.series)) startStory();
});
fetchStations().then((list) => {
  state.stations = list;
  if (state.series) renderAll();
});
