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
  reductionPct,
  SAME_ABS,
  SAME_REL,
  VENT_STATUSES,
  ventilationPlan,
  windowStats,
} from './planner.js';
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
const DEFAULT_FREE = '5-22';

const params = new URLSearchParams(location.search);
const demo = params.get('demo') === 'hanoi';
const DEMO_PLAN = '2026-10-31T21:00';
const sharedTime = (value) => /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):00$/.test(value ?? '') ? value : null;

function parseSharedGrid(value) {
  if (!/^-?\d{1,3}(?:\.\d{1,2})?,-?\d{1,3}(?:\.\d{1,2})?$/.test(value ?? '')) return null;
  const [lat, lon] = value.split(',').map(Number);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { name: 'Khu vực chia sẻ', lat, lon };
}
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
  demo,
  cityId: demo ? 'hanoi' : pick(params.get('city') ?? store.get('city', 'hanoi'), CITIES, 'hanoi'),
  myPlace: demo ? null : parseSharedGrid(params.get('grid')),
  shared: params.has('pick') && !demo ? { planned: sharedTime(params.get('plan')), chosen: sharedTime(params.get('pick')) } : null,
  sceneDate: null,
  sceneHour: null,
  profile: pick(params.get('profile') ?? store.get('profile', 'adult'), PROFILES, 'adult'),
  activity: pick(params.get('activity') ?? 'run', ACTIVITIES, 'run'),
  hours: DURATIONS.includes(Number(params.get('dur'))) ? Number(params.get('dur')) : 1,
  scope: pick(params.get('scope'), SCOPES, 'today'),
  scopeFromUrl: params.has('scope'),
  free: parseFree(params.get('free')) ?? parseFree(demo ? '15-22' : DEFAULT_FREE),
  planFromUrl: sharedTime(params.get('plan')) ?? parsePlan(params.get('plan')) ?? (demo ? DEMO_PLAN : null),
  planned: null, // chỉ số giờ bắt đầu của "giờ bạn định đi"
  selected: null, // khung người dùng bấm "Chọn"; null = theo đề xuất của app
  chartRange: 'day',
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
  const restoreFocus = container.contains(document.activeElement);
  container.replaceChildren(
    ...items.map((item) =>
      el(
        'button',
        {
          type: 'button',
          role: 'radio',
          class: chip ? 'chip' : null,
          'aria-checked': String(item.id === current),
          tabindex: item.id === current ? 0 : -1,
          onclick: () => onPick(item.id),
        },
        item.icon ? el('span', { 'aria-hidden': 'true' }, item.icon) : null,
        item.short ?? item.label,
      ),
    ),
  );
  // One tab stop per group; arrow keys select and keep focus after re-rendering.
  container.onkeydown = (event) => {
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const buttons = [...container.querySelectorAll('[role="radio"]')];
    const index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (index + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus({ preventScroll: true });
    buttons[next].click();
  };
  if (restoreFocus) container.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
}

function hourSelect(value, from, to, label, onchange) {
  return el(
    'select',
    { 'aria-label': label, onchange },
    ...Array.from({ length: to - from + 1 }, (_, k) => from + k).map((h) => el('option', { value: h, selected: h === value }, friendlyClock(h))),
  );
}

function levelPill(level, extra = '') {
  return el('span', { class: `pill ${extra}`, style: { background: level.display, color: level.ink } }, level.label);
}

const isSample = () => state.series?.source === 'sample';
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

function windowLabel(w) {
  const t = state.series.times[w.start];
  const h = hourOf(t);
  return {
    day: dayName(datePart(t)),
    range: `${formatClock(h)}–${formatClock(h + w.hours)}`,
  };
}

/** Nhãn có ngày tháng cụ thể, dùng cho nội dung gửi đi (người nhận đọc vào lúc khác). */
function absoluteLabel(w) {
  return fullWindowLabel(state.series.times[w.start]);
}

function fullWindowLabel(time) {
  const d = datePart(time);
  const hour = hourOf(time);
  return `${formatClock(hour)}–${formatClock(hour + state.hours)} · ${shortDate(d)}/${d.slice(0, 4)}`;
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
      `Gợi ý từ ClearHour: ${shareUrl(w)}\n` +
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
    `Dự báo lúc ${now.slice(11, 16)} ${shortDate(datePart(now))}, có thể thay đổi. Xem lại trước khi đi: ${shareUrl(w)}`,
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

function stateParams(w = state.chosen) {
  const p = new URLSearchParams();
  if (state.demo) p.set('demo', 'hanoi');
  p.set('city', state.cityId);
  if (state.myPlace && !isSample()) {
    const { gridLat, gridLon } = state.series;
    // Chia sẻ tọa độ ô lưới của mô hình, không đưa tọa độ thiết bị vào URL.
    if (Number.isFinite(gridLat) && Number.isFinite(gridLon)) p.set('grid', `${gridLat.toFixed(2)},${gridLon.toFixed(2)}`);
  }
  p.set('profile', state.profile);
  if (state.activity !== 'run') p.set('activity', state.activity);
  if (state.hours !== 1) p.set('dur', state.hours);
  p.set('scope', state.scope);
  const free = state.free.map((r) => `${r.from}-${r.to}`).join(',');
  if (free !== DEFAULT_FREE || state.demo) p.set('free', free);
  const { times } = state.series;
  const planned = state.shared?.planned ?? times[state.planned];
  const chosen = state.shared?.chosen ?? (w && times[w.start]);
  if (planned) p.set('plan', planned);
  if (chosen && (state.shared?.chosen || (!isSample() && state.selected != null))) p.set('pick', chosen);
  return p;
}

function syncUrl() {
  history.replaceState(null, '', `${location.pathname}?${stateParams()}${location.hash}`);
}

function shareUrl(w) {
  const p = stateParams(w);
  p.delete('profile');
  p.set('pick', state.series.times[w.start]);
  if (state.planned != null) p.set('plan', state.series.times[state.planned]);
  else p.delete('plan');
  return `${location.origin}${location.pathname}?${p}#ca-nhan`;
}

// ---------- Tải dữ liệu ----------

let loadVersion = 0;

async function load() {
  const version = ++loadVersion;
  const main = $('app');
  const banner = $('banner');
  const city = place();
  main.classList.add('is-loading');
  $('scene-hour').disabled = true;
  $('scene-source').textContent = 'Đang tải dữ liệu…';
  $('scene-plan').disabled = true;
  $('story-open').hidden = true;
  $('scene-time').value = '–:–';
  $('scene-pm').textContent = '–';
  banner.hidden = true;

  let series;
  try {
    if (state.demo) series = await fetchSample();
    else {
      try {
        series = await fetchAirQuality(city.lat, city.lon);
      } catch {
        series = await fetchSample();
      }
    }
  } catch {
    if (version !== loadVersion) return;
    main.classList.remove('is-loading');
    state.series = null;
    $('scene-source').textContent = 'Không có dữ liệu';
    banner.textContent = 'Không tải được dữ liệu. Hãy thử tải lại trang.';
    banner.hidden = false;
    return;
  }
  if (version !== loadVersion) return;

  state.series = series;
  state.sceneDate = null;
  state.planned = null;
  state.selected = null;
  if (isSample()) {
    banner.replaceChildren(
      state.demo ? 'Tình huống chạy bộ · ' : 'Dự báo trực tiếp tạm thời gián đoạn · ',
      `Dữ liệu mẫu Hà Nội ngày ${shortDate(todayStr())}/${todayStr().slice(0, 4)}. `,
      el('a', { href: `?city=${state.cityId}#ca-nhan` }, state.demo ? 'Xem dự báo trực tiếp' : 'Thử tải lại dự báo'),
    );
    banner.hidden = false;
  }
  if (!state.scopeFromUrl && state.scope === 'today' && !findBestWindows(series, plannerOpts('today')).best.length) {
    state.scope = 'tomorrow';
  }
  if (state.planFromUrl) {
    const value = state.planFromUrl;
    state.planFromUrl = null;
    const time = typeof value === 'string'
      ? value
      : `${addDays(todayStr(), value.day)}T${formatClock(value.hour)}`;
    const idx = series.times.indexOf(time);
    if (idx >= series.nowIndex) state.planned = idx;
  }
  const idx = series.times.indexOf(state.shared?.chosen);
  if (!isSample() && idx >= series.nowIndex) {
    state.selected = idx;
    const days = [state.selected, state.planned].filter((i) => i != null).map((i) => datePart(series.times[i]));
    if (days.every((d) => d === todayStr())) state.scope = 'today';
    else if (days.every((d) => d === addDays(todayStr(), 1))) state.scope = 'tomorrow';
    else state.scope = 'all';
  }
  main.classList.remove('is-loading');
  renderAll();
}

function renderSharedPlan() {
  const host = $('shared-plan');
  const { shared, series } = state;
  host.hidden = !shared?.chosen;
  if (host.hidden) return;
  const past = shared.chosen < series.times[series.nowIndex];
  const available = series.times.indexOf(shared.chosen) >= series.nowIndex;
  host.replaceChildren(
    el('p', {}, el('strong', {}, 'Lịch đã chia sẻ · '), fullWindowLabel(shared.chosen)),
    shared.planned ? el('p', {}, `Giờ định đi ban đầu: ${fullWindowLabel(shared.planned)}.`) : null,
    isSample() ? el('p', {}, 'Cần dữ liệu trực tiếp để đối chiếu lịch này.') :
      past ? el('p', {}, 'Khung giờ đã qua. Bên dưới là các lựa chọn từ dự báo mới.') :
        !available ? el('p', {}, 'Khung giờ nằm ngoài khoảng dự báo hiện có.') : null,
  );
}

function renderScene() {
  const s = state.series;
  const day = todayStr();
  const slider = $('scene-hour');
  if (state.sceneDate !== day) {
    state.sceneDate = day;
    state.sceneHour = hourOf(s.times[s.nowIndex]);
    slider.value = state.sceneHour;
    const colors = Array.from({ length: 24 }, (_, h) => {
      const idx = s.times.indexOf(`${day}T${formatClock(h)}`);
      const color = levelForPm25(s.pm25[idx])?.display ?? '#67725b';
      return `${color} ${(h / 24) * 100}% ${((h + 1) / 24) * 100}%`;
    });
    $('city-scene').style.setProperty('--scene-track', `linear-gradient(90deg, ${colors.join(', ')})`);
  }
  const hour = state.sceneHour;
  const time = formatClock(hour);
  const index = s.times.indexOf(`${day}T${time}`);
  const value = s.pm25[index];
  const scene = $('city-scene');
  const light = hour < 6 || hour >= 20 ? 'night' : hour >= 16 ? 'sunset' : 'day';
  const [wash, haze] = { night: ['#223e87', 0.72], sunset: ['#c26a34', 0.12], day: ['#87c9bc', 0.34] }[light];
  scene.style.setProperty('--scene-wash', wash);
  scene.style.setProperty('--scene-haze', haze);
  scene.style.setProperty('--scene-filter', { night: 'brightness(.65) saturate(.78)', day: 'brightness(1.12) saturate(.85)', sunset: 'none' }[light]);
  $('scene-time').value = time;
  $('scene-pm').textContent = num(value);
  $('scene-source').textContent = `${placeName()} · ${shortDate(day)} · ${isSample() ? 'Dữ liệu mẫu' : 'Mô hình CAMS'}`;
  slider.setAttribute('aria-valuetext', value == null ? `${time}, thiếu dữ liệu` : `${time}, PM2.5 ${num(value)} microgam trên mét khối`);
  slider.disabled = false;
  const canPlan = index >= s.nowIndex && hour + state.hours <= 24 && Boolean(windowStats(s.pm25, index, state.hours));
  const action = $('scene-plan');
  action.disabled = !canPlan;
  action.textContent = index < s.nowIndex ? 'Giờ này đã qua' : canPlan ? 'Dùng giờ này để so sánh ↓' : 'Không đủ dữ liệu cho khung giờ này';
}

// ---------- Render ----------

function renderAll() {
  if (!state.series || $('app').classList.contains('is-loading')) return;
  renderMeta();
  renderScene();
  renderSharedPlan();
  renderNow();
  renderPlanner();
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
  const model = idx < 0 ? null : s.pm25[idx];
  const ageMs = Date.now() - Date.parse(st.time);
  return { st, local, model, ageMs, age: ageText(ageMs), match: compareWithModel(st.pm25, model), level: levelForPm25(st.pm25) };
}

/** Một câu cho biết gợi ý đang dựa trên dữ liệu đáng tin đến đâu. */
function dataStatus(info) {
  const s = state.series;
  if (isSample()) {
    const t = s.times[s.nowIndex];
    return { tone: 'warn', text: `Đang xem dữ liệu mẫu của Hà Nội ngày ${shortDate(datePart(t))}/${t.slice(0, 4)}, không phải dự báo hiện tại.` };
  }
  if (!info) {
    return { tone: 'info', text: 'Không có số đo trạm nào trong 12 giờ qua (bán kính 30 km) để đối chiếu. Gợi ý dựa hoàn toàn trên mô hình dự báo, ô lưới khoảng 45 km.' };
  }
  const measuredAt = `${info.local.slice(11, 16)} ngày ${shortDate(datePart(info.local))}`;
  if (info.match == null) {
    return { tone: 'info', text: `Trạm đo ${num(info.st.pm25)} µg/m³ lúc ${measuredAt}. Mô hình thiếu dữ liệu cùng giờ để đối chiếu.` };
  }
  const pair = `${num(info.st.pm25)} so với ${num(info.model)} µg/m³, trạm đo lúc ${measuredAt}`;
  if (info.match === 'agree') return { tone: 'ok', text: `Trạm đo gần nhất khá khớp với mô hình (${pair}).` };
  if (info.match === 'station-higher') {
    return {
      tone: 'warn',
      text: `Trạm đo gần nhất đang cao hơn mô hình nhiều (${pair}). Thứ tự giờ ít bụi, nhiều bụi có thể vẫn đúng, nhưng mức bụi thực tế có thể cao hơn dự báo.`,
    };
  }
  return {
    tone: 'warn',
    text: `Trạm đo gần nhất đang thấp hơn mô hình nhiều (${pair}). Chưa rõ nguồn nào đúng hơn: mô hình có thể dự báo quá cao, hoặc cảm biến gặp trục trặc.`,
  };
}

function renderNow() {
  const s = state.series;
  const back = (arr) => Array.from({ length: 12 }, (_, k) => arr[s.nowIndex - k] ?? null);
  const aqi = combinedAqi({ pm2_5: nowcast(back(s.pm25)), pm10: nowcast(back(s.pm10)) });
  const modelLevel = levelForAqi(aqi);
  $('now-aqi').textContent = int(aqi);
  const pill = $('now-level');
  pill.textContent = modelLevel?.label ?? '–';
  pill.style.background = modelLevel?.display ?? '';
  pill.style.color = modelLevel?.ink ?? '';
  $('now-pm25').textContent = num(s.current.pm25 ?? s.pm25[s.nowIndex]);

  // Các phép so sánh theo ngày nằm riêng trong phần mở rộng, không lẫn với số liệu theo giờ
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
  $('now-advice').replaceChildren(
    el('strong', {}, `${profile.short}: `),
    level ? level.advice[profile.sensitive ? 'sensitive' : 'normal'] : '',
    stationWorse ? ` Lời khuyên này theo số đo trạm (mức ${info.level.label}), đang xấu hơn dự báo của mô hình.` : '',
  );
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
    state.shared = null;
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
    state.shared = null;
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
      const { day, range } = windowLabel({ start: i, hours: state.hours });
      return el('option', { value: i, selected: i === state.planned }, `${day} ${range}`);
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
  if (state.shared?.chosen && state.selected != null && !options.some((w) => w.start === state.selected)) {
    const shared = windowStats(s.pm25, state.selected, state.hours, act.ventilation);
    if (shared) options.push(shared);
  }
  if (!options.some((w) => w.start === state.selected)) state.selected = null;
  const chosen = options.find((w) => w.start === state.selected) ?? (mine && !shouldSwitch ? mine : top);
  Object.assign(state, { best: suggestions, mine, chosen });

  const free = state.free.map((r) => `${formatClock(r.from)}–${formatClock(r.to)}`).join(', ');
  $('plan-summary').textContent = `${act.short} · ${state.hours < 1 ? '30 phút' : `${state.hours} giờ`} · rảnh ${free}`;

  const out = [];
  if (!options.length) {
    out.push(el('p', { class: 'empty' }, 'Không còn giờ nào phù hợp trong các khoảng rảnh đã chọn. Thử chọn ngày khác hoặc nới khoảng rảnh.'));
  } else {
    if (chosen) out.push(verdictCard({ mine, top, cmp, shouldSwitch, worst, hasOthers: others.length > 0 }));
    if (chosen) {
      out.push(chosenBar(chosen, mine));
      out.push(el('a', { class: 'planner__chart-link', href: '#bieu-do', onclick: () => { $('chart-fold').open = true; } }, 'Xem các khung giờ trên biểu đồ ↓'));
    }

    const level = levelForAqi(chosen?.aqi);
    if (chosen?.aqi > (profile.sensitive ? 100 : 150)) {
      out.push(el('p', { class: 'warn' }, `Khung đã chọn vẫn ở mức ${level.label}. ${level.advice[profile.sensitive ? 'sensitive' : 'normal']}`));
    }
  }

  if (options.length > 1) {
    out.push(el(
      'details',
      { class: 'more', open: state.optionsOpen, ontoggle: (e) => { state.optionsOpen = e.target.open; } },
      el('summary', {}, 'Xem các giờ khác'),
      optionList({ options, mine, suggestions, chosen }),
    ));
  }

  const status = dataStatus(stationInfo());
  out.push(el('p', { class: `status status--${status.tone}` }, el('strong', {}, 'Độ tin cậy của dữ liệu: '), status.text));

  const notes = [`Phần trăm tính trên PM2.5 trung bình dự báo của cả khung. Hai khung chênh dưới ${SAME_REL * 100}% hoặc dưới ${SAME_ABS} µg/m³ được coi là tương đương.`];
  if (chosen && profile.id === 'adult') {
    notes.push(`Ước tính ở khung đã chọn, người lớn hít vào khoảng ${int(chosen.dose)} µg bụi mịn (cường độ ${act.intensity}, ~${num(act.ventilation)} m³ không khí/giờ).`);
  } else if (chosen) {
    notes.push(`Hồ sơ «${profile.short}» chỉ đổi lời khuyên và ngưỡng cảnh báo; số liệu bụi giữ nguyên. Không hiện ước tính µg hít vào vì hệ số thông khí là của người lớn.`);
  }
  out.push(el('p', { class: 'muted small' }, notes.join(' ')));
  $('results').replaceChildren(...out);
}

/** Một bên của phép so sánh: nhãn, giờ, ngày, PM2.5 trung bình dự báo, mức. */
function sideBox(tag, w, extraClass = '') {
  const { day, range } = windowLabel(w);
  return el(
    'div',
    { class: `duel__side ${extraClass}` },
    el('span', { class: 'duel__tag' }, tag),
    el('span', { class: 'duel__time' }, range),
    el('span', { class: 'duel__day' }, day),
    el('span', { class: 'duel__pm' }, `PM2.5 ${num(w.mean)} µg/m³ `, levelPill(levelForAqi(w.aqi), 'pill--sm')),
  );
}

function verdictCard({ mine, top, cmp, shouldSwitch, worst, hasOthers }) {
  if (mine && shouldSwitch) {
    const tl = windowLabel(top);
    return el(
      'div',
      { class: 'verdict-card' },
      el('p', { class: 'verdict-card__title' }, `Nên dời sang ${tl.day.toLowerCase()} ${tl.range}`),
      el('p', { class: 'verdict-card__sub' }, 'Bụi mịn dự báo thấp hơn ', el('strong', {}, `${cmp.pct}%`), ' so với giờ bạn định đi.'),
      el(
        'div',
        { class: 'duel' },
        sideBox('Giờ bạn định đi', mine),
        el('span', { class: 'duel__arrow', 'aria-hidden': 'true' }, '→'),
        sideBox('Đề xuất', top, 'duel__side--to'),
      ),
    );
  }
  if (mine) {
    const ml = windowLabel(mine);
    let sub = 'Không có lúc rảnh nào khác để so sánh.';
    if (top) {
      const tl = windowLabel(top);
      sub = `Lúc rảnh ít bụi nhất (${tl.day.toLowerCase()} ${tl.range}) chỉ chênh ${num(Math.abs(cmp.diff))} µg/m³, không đáng để đổi lịch.`;
    } else if (hasOthers) {
      sub = 'Những lúc rảnh khác đều nhiều bụi hơn giờ này.';
    }
    return el(
      'div',
      { class: 'verdict-card' },
      el('p', { class: 'verdict-card__title' }, `Giữ lịch cũ: ${ml.day.toLowerCase()} ${ml.range}`),
      el('p', { class: 'verdict-card__sub' }, sub),
      el('div', { class: 'duel' }, sideBox('Giờ bạn định đi', mine, 'duel__side--to')),
    );
  }
  if (!top) return el('p', { class: 'empty' }, 'Không có lựa chọn phù hợp khác trong những khoảng rảnh.');
  const tl = windowLabel(top);
  const spread = worst && worst.start !== top.start ? reductionPct(top.mean, worst.mean) : 0;
  return el(
    'div',
    { class: 'verdict-card' },
    el('p', { class: 'verdict-card__title' }, `Ít bụi nhất trong lúc bạn rảnh: ${tl.day.toLowerCase()} ${tl.range}`),
    el(
      'p',
      { class: 'verdict-card__sub' },
      spread ? `Thấp hơn ${spread}% so với giờ nhiều bụi nhất trong lúc bạn rảnh (${windowLabel(worst).range}). ` : '',
      'Chọn «Giờ bạn định đi» ở trên để biết đổi giờ giúp giảm bao nhiêu so với lịch của bạn.',
    ),
    el('div', { class: 'duel' }, sideBox('Đề xuất', top, 'duel__side--to')),
  );
}

function optionList({ options, mine, suggestions, chosen }) {
  return el(
    'ul',
    { class: 'options', 'aria-label': 'Các lựa chọn để so sánh' },
    ...options.map((w) => {
      const { day, range } = windowLabel(w);
      const isMine = mine?.start === w.start;
      const isChosen = chosen?.start === w.start;
      const rank = suggestions.indexOf(w) + 1;
      let delta = null;
      if (mine && !isMine) {
        const c = compareWithPlan(mine, w);
        delta = c.relation === 'same' ? 'gần tương đương giờ bạn định đi' : `${c.relation === 'better' ? 'thấp' : 'cao'} hơn ${c.pct}% so với giờ bạn định đi`;
      }
      return el(
        'li',
        { class: `option${isChosen ? ' option--chosen' : ''}` },
        isMine
          ? el('span', { class: 'option__mark option__mark--plan', title: 'Giờ bạn định đi' })
          : el('span', { class: 'option__mark', title: rank ? 'Khung đề xuất' : 'Khung đã chia sẻ' }, rank || '↗'),
        el(
          'span',
          { class: 'option__main' },
          el('span', { class: 'option__time' }, `${day} · ${range}`),
          el(
            'span',
            { class: 'option__detail' },
            `${isMine ? 'Giờ bạn định đi · ' : ''}PM2.5 ${num(w.mean)} µg/m³ · ${levelForAqi(w.aqi).label}${delta ? ` · ${delta}` : ''}`,
          ),
        ),
        el(
          'button',
          {
            type: 'button',
            class: `btn btn--xs ${isChosen ? '' : 'btn--ghost'}`,
            'aria-pressed': String(isChosen),
            'aria-label': `Chọn khung ${day.toLowerCase()} ${range}`,
            onclick: () => {
              if (state.selected !== w.start) state.shared = null;
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

/** Hành động sau quyết định: đưa khung đã chọn vào lịch hoặc gửi cho nhóm. */
function chosenBar(chosen, mine) {
  const { day, range } = windowLabel(chosen);
  const head = el('p', { class: 'chosen__label' }, 'Khung đã chọn: ', el('strong', {}, `${day.toLowerCase()} ${range}`));
  if (isSample()) {
    return el('div', { class: 'chosen' }, head, el('p', { class: 'muted small' }, 'Đây là lịch minh họa từ dữ liệu mẫu nên không xuất ra lịch hay tin nhắn.'));
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
      el('a', { class: 'btn btn--xs', href: googleCalendarUrl(ev), target: '_blank', rel: 'noopener' }, '📅 Thêm vào Google Lịch'),
      el('button', { type: 'button', class: 'btn btn--ghost btn--xs', onclick: () => downloadIcs(ev, ev.fileName) }, '⬇ Tệp lịch .ics'),
      el(
        'button',
        {
          type: 'button',
          class: 'btn btn--ghost btn--xs',
          onclick: () =>
            copyText(preview.textContent, status, () => {
              preview.hidden = false;
              selectContents(preview);
            }),
        },
        '💬 Sao chép tin nhắn rủ nhóm',
      ),
      status,
    ),
    preview,
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
          `${windowLabel(w).day} ${windowLabel(w).range}`,
          el('small', {}, ` · PM2.5 ~${num(w.mean)}`),
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
  const chosen = state.chosen?.start ?? s.nowIndex;
  const planned = state.mine?.start ?? chosen;
  const first = datePart(s.times[Math.min(chosen, planned)]);
  const last = datePart(s.times[Math.max(chosen, planned)]);
  let start = Math.max(0, s.nowIndex - 6);
  let end = Math.min(s.times.length, s.nowIndex + 72);
  if (state.chartRange === 'day') {
    start = s.times.findIndex((t) => datePart(t) === first);
    end = s.times.findIndex((t) => datePart(t) > last);
    if (end < 0) end = s.times.length;
  }
  renderChart($('chart-scroll'), $('tooltip'), {
    series: s,
    start,
    end,
    windows: state.best.map((w, i) => ({ start: w.start, hours: w.hours, rank: i + 1, selected: w.start === chosen })),
    selected: state.chosen,
    planned: state.mine,
    dayText: (d) => `${weekday(d)} ${shortDate(d)} · TB ngày ${num(dailyMean(s, d))}`,
  });
  $('chart-sub').textContent =
    (state.chartRange === 'day' ? first === last ? `${dayWithDate(first)}.` : `Từ ${shortDate(first)} đến ${shortDate(last)}.` : '72 giờ tới.') +
    ' Cột tô màu theo mức VN_AQI của từng giờ; cột mờ là giờ đã qua.';

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
            el('span', { class: 'verdict__meta' }, `PM2.5 cao nhất ${num(v.peak)}, trung bình ${num(v.mean)} µg/m³ · ${v.level.label}`),
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
      $('ca-nhan').scrollIntoView();
      $('planned').focus({ preventScroll: true });
    },
  });
}

// ---------- Khởi tạo ----------

function initControls() {
  const theme = $('theme');
  const savedTheme = store.get('theme', 'system');
  theme.value = ['system', 'light', 'dark'].includes(savedTheme) ? savedTheme : 'system';
  theme.addEventListener('change', () => {
    if (theme.value === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme.value;
    store.set('theme', theme.value);
  });

  const city = $('city');
  city.replaceChildren(...CITIES.map((c) => el('option', { value: c.id, selected: c.id === state.cityId }, c.name)));
  const showCustomPlace = () => {
    city.querySelector('option[value="me"]')?.remove();
    city.prepend(el('option', { value: 'me' }, state.myPlace.name));
    city.value = 'me';
  };
  if (state.myPlace) showCustomPlace();
  city.addEventListener('change', () => {
    if (city.value === 'me') return;
    state.cityId = city.value;
    state.demo = false;
    state.shared = null;
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
        state.demo = false;
        state.shared = null;
        showCustomPlace();
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
    state.shared = null;
    state.planned = e.target.value === '' ? null : Number(e.target.value);
    state.selected = null;
    renderAll();
  });

  $('story-open').addEventListener('click', startStory);
  $('chart-fold').addEventListener('toggle', (e) => {
    if (e.target.open && state.series) renderChartSection();
  });
  $('scene-plan').addEventListener('click', () => {
    state.scope = 'today';
    state.shared = null;
    state.selected = null;
    state.planned = state.series.times.indexOf(`${state.sceneDate}T${formatClock(state.sceneHour)}`);
    renderAll();
    location.hash = '#ca-nhan';
    $('ca-nhan').focus({ preventScroll: true });
  });

  $('scene-hour').addEventListener('input', (e) => {
    state.sceneHour = Number(e.target.value);
    if (state.series) renderScene();
  });

  $('add-slot').addEventListener('click', () => {
    state.slots[state.orgType].push({ name: 'Hoạt động mới', from: '08:00', to: '09:00' });
    saveSlots();
    renderOrg();
  });
  $('copy-notice').addEventListener('click', copyNotice);

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => state.series && $('chart-fold').open && renderChartSection(), 150);
  });

  renderLegend();
}

initControls();
load().then(() => {
  if (location.hash === '#cau-chuyen' && state.series && buildStory(state.series)) startStory();
});
fetchStations().then((list) => {
  state.stations = list;
  if (state.series && !$('app').classList.contains('is-loading')) renderAll();
});
