import { localized, language, localizeShell, localizedHref, t } from './i18n.js';
import { accuracyNear, correctSeries, correctValues, fetchAccuracy, testDays } from './accuracy.js';
import { aqiFromConcentration, cigarettesPerDay, combinedAqi, LEVELS, levelForAqi, levelForPm25, nowcast, WHO_PM25_24H } from './aqi.js';
import { alignWeather, fetchAirQuality, fetchHistory, fetchSample, fetchWeather } from './api.js';
import { downloadIcs, googleCalendarUrl, localToUtc } from './calendar.js';
import { chartHourFlags, renderChart } from './chart.js';
import { decideOutdoorPlan, describeOutdoorWindow, hasAvoid } from './conditions.js';
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
import { cleanGrid, cleanestHour, lookBack, slotHistory } from './history.js';
import { ageText, compareWithModel, fetchStations, haversineKm, nearestStation, toLocalTime } from './stations.js';
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
  { id: 'today', label: t('Hôm nay') },
  { id: 'tomorrow', label: t('Ngày mai') },
  { id: 'all', label: t('3 ngày tới') },
];
const ORG_TYPES = [
  { id: 'school', label: t('Trường học') },
  { id: 'business', label: t('Doanh nghiệp') },
];
const CHART_RANGES = [
  { id: 'day', label: t('Trong ngày') },
  { id: 'all', label: t('72 giờ') },
];
const STATUS_ICON = { ok: '✅', caution: '⚠️', stop: '⛔' };
const DEFAULT_FREE = '5-22';
const NEW_SLOT_NAME = 'Hoạt động mới';
const PRESET_SLOT_NAMES = new Set([
  NEW_SLOT_NAME,
  ...Object.values(ORG_PRESETS).flatMap((preset) => preset.slots.map((slot) => slot.name)),
]);
const displaySlotName = (slot) => !slot.customName && PRESET_SLOT_NAMES.has(slot.name) ? t(slot.name) : slot.name;

const params = new URLSearchParams(location.search);
const demo = params.get('demo') === 'hanoi';
const DEMO_PLAN = '2026-10-31T21:00';
const sharedTime = (value) => /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):00$/.test(value ?? '') ? value : null;

function parseSharedGrid(value) {
  if (!/^-?\d{1,3}(?:\.\d{1,2})?,-?\d{1,3}(?:\.\d{1,2})?$/.test(value ?? '')) return null;
  const [lat, lon] = value.split(',').map(Number);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { name: t('Khu vực chia sẻ'), lat, lon };
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
  series: null, // bản đang hiển thị (đã hiệu chỉnh theo trạm nếu có)
  rawSeries: null, // dự báo gốc của mô hình
  weatherStatus: 'unavailable',
  accuracy: null, // kết quả kiểm tra dự báo so với trạm đo
  useCorrection: true,
  history: null, // dữ liệu từng giờ của khoảng 30 ngày qua (bản gốc)
  historyView: null, // bản đã hiệu chỉnh theo trạm nếu có
  historyKey: null,
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
  return isSample() ? t('Hà Nội') : t(place().name);
}

function todayStr() {
  return datePart(state.series.times[state.series.nowIndex]);
}

/** "Hôm nay / Ngày mai" với dữ liệu trực tiếp; ngày cụ thể khi đang xem dữ liệu mẫu để không ai hiểu nhầm. */
function dayName(dateStr) {
  return isSample() ? `${weekday(dateStr)} ${shortDate(dateStr)}` : dayLabel(dateStr, todayStr());
}

const inlineDay = (label) => language === 'vi' || label === 'Today' || label === 'Tomorrow' ? label.toLowerCase() : label;

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
  return `${formatClock(hour)}–${formatClock(hour + state.hours)} · ${shortDate(d, true)}`;
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
    title: t`${act.icon} ${act.short} – giờ ít bụi mịn`,
    description:
      t`PM2.5 dự báo trung bình ${num(w.mean)} µg/m³ (${levelForAqi(w.aqi).label}).\n` +
      t`Gợi ý từ ClearHour: ${shareUrl(w)}\n` +
      t('Dự báo mang tính tham khảo, hãy xem lại trước khi ra ngoài.') +
      (state.weatherStatus === 'unavailable' ? '\n' + t('Chưa có dự báo thời tiết. Hãy kiểm tra mưa và nhiệt độ trước khi đi.') : ''),
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
  let line = t`Bụi mịn PM2.5 dự báo khoảng ${num(w.mean)} µg/m³ (${levelForAqi(w.aqi).label})`;
  if (mine && compareWithPlan(mine, w).relation === 'better') {
    line += t`, thấp hơn ${compareWithPlan(mine, w).pct}% so với ${absoluteLabel(mine)}`;
  }
  return [
    t`${act.icon} ${act.short}: ${absoluteLabel(w)} tại ${placeName()}.`,
    `${line}.`,
    ...(state.weatherStatus === 'unavailable' ? [t('Chưa có dự báo thời tiết. Hãy kiểm tra mưa và nhiệt độ trước khi đi.')] : []),
    t`Dự báo lúc ${now.slice(11, 16)} ${shortDate(datePart(now))}, có thể thay đổi. Xem lại trước khi đi: ${shareUrl(w)}`,
  ].join('\n');
}

async function copyText(text, status, onFail) {
  try {
    await navigator.clipboard.writeText(text);
    status.textContent = t('Đã sao chép ✓');
  } catch {
    onFail();
    status.textContent = t('Đã bôi đen nội dung, nhấn Ctrl+C để sao chép');
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
  p.set('lang', language);
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
  $('scene-source').textContent = t('Đang tải dữ liệu…');
  $('scene-plan').disabled = true;
  $('print-org').disabled = true;
  $('story-promo').hidden = true;
  $('scene-time').value = '–:–';
  $('scene-pm').textContent = '–';
  banner.hidden = true;

  const weatherRequest = state.demo ? null : fetchWeather(city.lat, city.lon).catch(() => null);
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
    state.rawSeries = null;
    $('scene-source').textContent = t('Không có dữ liệu');
    banner.textContent = t('Không tải được dữ liệu. Hãy thử tải lại trang.');
    banner.hidden = false;
    return;
  }
  if (version !== loadVersion) return;

  state.rawSeries = series;
  state.weatherStatus = series.source === 'sample' ? 'sample' : 'loading';
  if (series.source === 'sample') Object.assign(state, { history: null, historyKey: null });
  else loadHistory();
  deriveSeries();
  state.sceneDate = null;
  state.planned = null;
  state.selected = null;
  if (isSample()) {
    banner.replaceChildren(
      state.demo ? t('Tình huống chạy bộ · ') : t('Dự báo trực tiếp tạm thời gián đoạn · '),
      localized(`Dữ liệu mẫu Hà Nội ngày ${shortDate(todayStr(), true)}. `, `Hanoi sample data from ${shortDate(todayStr(), true)}. `),
      el('a', { href: localizedHref(`?city=${state.cityId}#ca-nhan`) }, state.demo ? t('Xem dự báo trực tiếp') : t('Thử tải lại dự báo')),
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

  if (!weatherRequest || isSample()) return;
  // Dữ liệu không khí đã hiển thị. Chỉ cập nhật thời tiết cho lần tải còn hiệu lực.
  const rawWeather = await weatherRequest;
  if (version !== loadVersion) return;
  const weather = alignWeather(series.times, rawWeather);
  state.weatherStatus = weather ? 'ready' : 'unavailable';
  state.rawSeries = { ...state.rawSeries, weather };
  deriveSeries();
  renderAll();
}

/** Trạm đã kiểm tra dự báo gần nơi đang xem (không dùng cho dữ liệu mẫu). */
function accuracyEntry() {
  if (!state.accuracy || state.rawSeries?.source === 'sample') return null;
  const p = place();
  return accuracyNear(state.accuracy, p.lat, p.lon);
}

/** Bản dự báo để hiển thị: đã hiệu chỉnh theo trạm (nếu có và người dùng không tắt) hoặc bản gốc. */
function deriveSeries() {
  if (!state.rawSeries) return;
  const entry = state.useCorrection ? accuracyEntry() : null;
  state.series = correctSeries(state.rawSeries, entry);
  const h = state.history;
  state.historyView = h && entry?.apply && entry.factors
    ? { ...h, pm25: correctValues(h.times, h.pm25, entry.factors, h.utcOffsetSeconds) }
    : h;
}

/** Tải dữ liệu 30 ngày qua của nơi đang xem (chạy nền, không chặn phần dự báo). */
function loadHistory() {
  const p = place();
  const k = `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`;
  if (state.historyKey === k) return;
  Object.assign(state, { history: null, historyView: null, historyKey: k });
  fetchHistory(p.lat, p.lon)
    .then((h) => {
      if (state.historyKey !== k) return;
      state.history = h;
      deriveSeries();
      renderAll();
    })
    .catch(() => {});
}

/** Một câu nhìn lại 30 ngày cho phần cá nhân. */
function lookBackNote(mine) {
  const h = state.historyView;
  if (!h || isSample()) return null;
  const planHour = mine ? hourOf(state.series.times[mine.start]) : null;
  const r = lookBack(h, { today: todayStr(), planHour, hours: state.hours, ranges: state.free });
  if (!r) return null;
  let text;
  if (planHour == null && r.usualCount * 2 >= r.days) {
    text = t`Nhìn lại ${r.days} ngày qua: trong những giờ bạn rảnh, lúc ít bụi nhất thường là ${friendlyClock(r.usualHour)} (${r.usualCount}/${r.days} ngày).`;
  } else if (planHour == null) {
    text = t`Nhìn lại ${r.days} ngày qua: lúc ít bụi nhất trong những giờ bạn rảnh đổi theo từng ngày, hay gặp nhất là ${friendlyClock(r.usualHour)} (chỉ ${r.usualCount}/${r.days} ngày). Vì vậy nên xem dự báo mỗi ngày.`;
  } else if (r.worth && r.pct > 0) {
    text = t`Nhìn lại ${r.days} ngày qua: so với luôn đi lúc ${friendlyClock(planHour)}, chọn giờ chỉ dựa trên bụi mịn có thể giảm khoảng ${r.pct}% PM2.5 trung bình. Có ${r.worth}/${r.days} ngày mức giảm đủ lớn.`;
  } else {
    text = t`Nhìn lại ${r.days} ngày qua: dự báo PM2.5 tại ${friendlyClock(planHour)} thường gần với mức thấp nhất trong những giờ bạn rảnh.`;
  }
  return el(
    'p',
    { class: 'lookback' },
    el('span', { class: 'lookback__icon', 'aria-hidden': 'true' }, '📅'),
    el('span', {}, text, ' ', el('small', { class: 'muted' }, t('Mô phỏng dựa trên PM2.5 của mô hình trong quá khứ, chưa tính thời tiết hay ozone.'))),
  );
}

function renderSharedPlan() {
  const host = $('shared-plan');
  const { shared, series } = state;
  host.hidden = !shared?.chosen;
  if (host.hidden) return;
  const past = shared.chosen < series.times[series.nowIndex];
  const available = series.times.indexOf(shared.chosen) >= series.nowIndex;
  host.replaceChildren(
    el('p', {}, el('strong', {}, t('Lịch đã chia sẻ · ')), fullWindowLabel(shared.chosen)),
    shared.planned ? el('p', {}, t`Giờ định đi ban đầu: ${fullWindowLabel(shared.planned)}.`) : null,
    isSample() ? el('p', {}, t('Cần dữ liệu trực tiếp để đối chiếu lịch này.')) :
      past ? el('p', {}, t('Khung giờ đã qua. Bên dưới là các lựa chọn từ dự báo mới.')) :
        !available ? el('p', {}, t('Khung giờ nằm ngoài khoảng dự báo hiện có.')) : null,
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
  $('scene-source').textContent = `${placeName()} · ${shortDate(day)} · ${isSample() ? t('Dữ liệu mẫu') : t('Mô hình CAMS')}`;
  slider.setAttribute('aria-valuetext', value == null ? t`${time}, thiếu dữ liệu` : t`${time}, PM2.5 ${num(value)} microgam trên mét khối`);
  slider.disabled = false;
  const canPlan = index >= s.nowIndex && hour + state.hours <= 24 && Boolean(windowStats(s.pm25, index, state.hours));
  const action = $('scene-plan');
  action.disabled = !canPlan;
  action.textContent = index < s.nowIndex ? t('Giờ này đã qua') : canPlan ? t('Dùng giờ này để so sánh ↓') : t('Không đủ dữ liệu cho khung giờ này');
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
  $('story-promo').hidden = state.weatherStatus === 'loading' || !buildStory(state.series);
  renderOrg();
  renderAccuracy();
  syncUrl();
}

/** Thẻ "Dự báo đúng đến đâu?": kết quả kiểm tra dự báo so với trạm đo gần nơi đang xem. */
function renderAccuracy() {
  const box = $('accuracy-card');
  const title = el('h3', {}, t('Dự báo đúng đến đâu?'));
  const entry = accuracyEntry();
  if (!entry) {
    const cities = [...new Set((state.accuracy?.stations ?? [])
      .filter((s) => s.test)
      .map((s) => CITIES.find((c) => haversineKm(c.lat, c.lon, s.lat, s.lon) <= 30))
      .filter(Boolean)
      .map((c) => t(c.name)))];
    let text = t('Chưa có kết quả kiểm tra dự báo. Kết quả được tính lại mỗi ngày khi trang cập nhật.');
    if (isSample()) text = t('Phần này cần dự báo trực tiếp nên không áp dụng cho dữ liệu mẫu.');
    else if (cities.length) text = t`Quanh khu vực này (30 km) chưa có trạm đo đủ dữ liệu để kiểm tra dự báo. Hiện ClearHour kiểm tra được ở: ${cities.join(', ')}.`;
    box.replaceChildren(title, el('p', {}, text));
    return;
  }
  const r = entry.test;
  const pct = (v) => `${Math.round(v * 100)}%`;
  const fixed = entry.apply;
  const higher = r.biasRaw < 0;
  const items = [
    fixed
      ? t`Đoán đúng mức không khí (Tốt, Trung bình, Kém…) ở ${pct(r.levelRaw)} số giờ; sau hiệu chỉnh là ${pct(r.levelCorr)}.`
      : t`Đoán đúng mức không khí (Tốt, Trung bình, Kém…) ở ${pct(r.levelRaw)} số giờ.`,
    fixed
      ? t`So hai giờ trong cùng ngày, dự báo chỉ ra đúng giờ nào ít bụi hơn ${pct(r.orderRaw)} số lần; sau hiệu chỉnh là ${pct(r.orderCorr)}.`
      : t`So hai giờ trong cùng ngày, dự báo chỉ ra đúng giờ nào ít bụi hơn ${pct(r.orderRaw)} số lần.`,
    (higher
      ? t`Mô hình thường dự báo cao hơn số đo khoảng ${num(Math.abs(r.biasRaw))} µg/m³, mỗi giờ lệch trung bình ${num(r.maeRaw)} µg/m³`
      : t`Mô hình thường dự báo thấp hơn số đo khoảng ${num(Math.abs(r.biasRaw))} µg/m³, mỗi giờ lệch trung bình ${num(r.maeRaw)} µg/m³`) +
      (fixed ? t`; sau hiệu chỉnh còn ${num(r.maeCorr)} µg/m³.` : '.'),
  ];
  const verdict = fixed
    ? t('ClearHour đang dùng bản hiệu chỉnh này cho khu vực của bạn.')
    : entry.reason === 'low-cost'
      ? t('Đây là cảm biến giá rẻ, độ chính xác có hạn, nên chỉ dùng để đối chiếu chứ không dùng để hiệu chỉnh.')
      : t('Hiệu chỉnh không giúp dự báo tốt hơn rõ rệt nên ClearHour giữ nguyên dự báo gốc.');
  box.replaceChildren(
    title,
    el('p', {}, entry.isMonitor
      ? t`So với trạm đo ${entry.name} (cách ${num(entry.km)} km) trong ${testDays(r)} ngày gần nhất:`
      : t`So với cảm biến ${entry.name} (cách ${num(entry.km)} km) trong ${testDays(r)} ngày gần nhất:`),
    el('ul', { class: 'accuracy__list' }, ...items.map((x) => el('li', {}, x))),
    el('p', {}, verdict),
    el('p', { class: 'muted small' },
      t`Cách kiểm tra: ghép ${int(entry.n)} giờ có cả số đo và dự báo trong khoảng 60 ngày qua. Phần 2/3 thời gian đầu dùng để tính hệ số hiệu chỉnh cho từng giờ trong ngày, 1/3 còn lại dùng để chấm điểm. Dữ liệu quá khứ của Open-Meteo là mô hình chạy sát giờ, không phải bản dự báo trước 1–3 ngày bạn đang xem, nên sai số thật có thể lớn hơn.`),
  );
}

/** Dòng cho biết dự báo đang được hiệu chỉnh theo trạm nào, kèm nút xem bản gốc. */
function correctionNote() {
  const entry = accuracyEntry();
  if (!entry?.apply) return null;
  const on = Boolean(state.series.corrected);
  return el(
    'p',
    { class: 'status status--ok' },
    on
      ? t`Dự báo đã được hiệu chỉnh theo trạm đo ${entry.name} (cách ${num(entry.km)} km) nên sát thực tế hơn. `
      : t('Đang xem dự báo gốc của mô hình, chưa hiệu chỉnh. '),
    el('button', {
      type: 'button',
      class: 'btn btn--ghost btn--xs',
      onclick: () => {
        state.useCorrection = !on;
        deriveSeries();
        renderAll();
      },
    }, on ? t('Xem dự báo gốc') : t('Dùng bản hiệu chỉnh')),
    ' ',
    el('a', { href: '#accuracy-card' }, t('Đúng đến đâu?')),
  );
}

function renderMeta() {
  const s = state.series;
  const now = s.times[s.nowIndex];
  const last = s.times[s.times.length - 1];
  $('updated').textContent = isSample()
    ? t('Dữ liệu mẫu')
    : t`Dữ liệu lúc ${now.slice(11, 16)} ${shortDate(datePart(now))} · dự báo đến ${weekday(datePart(last))} ${shortDate(datePart(last))}`;
  $('now-place').textContent = isSample()
    ? `${t('Hà Nội (dữ liệu mẫu)')} · ${now.slice(11, 16)} · ${shortDate(datePart(now), true)}`
    : `${placeName()} · ${now.slice(11, 16)}`;
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
    const date = shortDate(datePart(t), true);
    return { tone: 'warn', text: localized(`Bạn đang xem dữ liệu mẫu Hà Nội ngày ${date}.`, `Showing Hanoi sample data from ${date}.`) };
  }
  if (!info) {
    return { tone: 'info', text: t('Không có số đo trạm nào trong 12 giờ qua (bán kính 30 km) để đối chiếu. Gợi ý dựa hoàn toàn trên mô hình dự báo, ô lưới khoảng 45 km.') };
  }
  const measuredAt = t`${info.local.slice(11, 16)} ngày ${shortDate(datePart(info.local))}`;
  if (info.match == null) {
    return { tone: 'info', text: t`Trạm đo ${num(info.st.pm25)} µg/m³ lúc ${measuredAt}. Mô hình thiếu dữ liệu cùng giờ để đối chiếu.` };
  }
  const pair = t`${num(info.st.pm25)} so với ${num(info.model)} µg/m³, trạm đo lúc ${measuredAt}`;
  if (info.match === 'agree') return { tone: 'ok', text: t`Trạm đo gần nhất khá khớp với mô hình (${pair}).` };
  if (info.match === 'station-higher') {
    return {
      tone: 'warn',
      text: t`Trạm đo gần nhất đang cao hơn mô hình nhiều (${pair}). Thứ tự giờ ít bụi, nhiều bụi có thể vẫn đúng, nhưng mức bụi thực tế có thể cao hơn dự báo.`,
    };
  }
  return {
    tone: 'warn',
    text: t`Trạm đo gần nhất đang thấp hơn mô hình nhiều (${pair}). Chưa rõ nguồn nào đúng hơn: mô hình có thể dự báo quá cao, hoặc cảm biến gặp trục trặc.`,
  };
}

function renderNow() {
  const s = state.series;
  const back = (arr) => Array.from({ length: 12 }, (_, k) => arr[s.nowIndex - k] ?? null);
  const pmAqi = combinedAqi({ pm2_5: nowcast(back(s.pm25)), pm10: nowcast(back(s.pm10)) });
  // O3 tính theo trung bình 1 giờ, không dùng NowCast
  const o3 = s.o3?.[s.nowIndex] ?? s.current.o3;
  const o3Aqi = aqiFromConcentration(o3, 'o3_1h');
  const aqi = combinedAqi({ pm2_5: nowcast(back(s.pm25)), pm10: nowcast(back(s.pm10)), o3 });
  const modelLevel = levelForAqi(aqi);
  $('o3-row').hidden = o3 == null;
  $('now-o3').textContent = num(o3);
  $('now-aqi').textContent = int(aqi);
  const pill = $('now-level');
  pill.textContent = modelLevel?.label ?? '–';
  pill.style.background = modelLevel?.display ?? '';
  pill.style.color = modelLevel?.ink ?? '';
  $('now-pm25').textContent = num(s.current.pm25 ?? s.pm25[s.nowIndex]);
  $('aqi-spectrum').replaceChildren(...LEVELS.map((level) => el('span', {
    class: level === modelLevel ? 'is-current' : null,
    title: level.label,
    style: { backgroundColor: level.display },
  })));

  // Các phép so sánh theo ngày nằm riêng trong phần mở rộng, không lẫn với số liệu theo giờ
  const mean = dailyMean(s, todayStr());
  const ratio = mean / WHO_PM25_24H;
  $('now-daymean').textContent = num(mean);
  $('now-who').textContent = mean == null ? '–' : ratio > 1 ? t`gấp ${num(ratio)} lần` : t('trong mức khuyến nghị');
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
    stationWorse ? t` Lời khuyên này theo số đo trạm (mức ${info.level.label}), đang xấu hơn dự báo của mô hình.` : '',
    !stationWorse && o3Aqi > pmAqi && o3Aqi > 50 ? t(' Chỉ số lúc này chủ yếu do ozone, chất thường tăng vào trưa nắng.') : '',
  );
}

function renderStation(info) {
  const row = $('station-row');
  row.hidden = isSample() || !state.stations.length;
  if (row.hidden) return;
  if (!info) {
    $('station-meta').textContent = t('Không có trạm nào đo trong 12 giờ qua, bán kính 30 km');
    $('station-val').replaceChildren('–');
    return;
  }
  const { st, local } = info;
  const when = datePart(local) === todayStr() ? local.slice(11, 16) : `${local.slice(11, 16)} ${shortDate(datePart(local))}`;
  $('station-meta').textContent =
    t`${st.name} · cách ${num(st.km)} km · đo lúc ${when} (${info.age})` + (st.isMonitor ? '' : t(' · cảm biến giá rẻ'));
  $('station-val').replaceChildren(
    num(st.pm25),
    ' ',
    el('small', {}, 'µg/m³'),
    el('small', { class: 'sub' }, t`mức ${info.level.label} · mô hình lúc đó: ${num(info.model)}`),
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
        hourSelect(r.from, 0, 23, t('Rảnh từ'), (e) => {
          r.from = Number(e.target.value);
          if (r.to <= r.from) r.to = Math.min(24, r.from + 1);
          changed();
        }),
        el('span', { 'aria-hidden': 'true' }, '–'),
        hourSelect(r.to, 1, 24, t('Rảnh đến'), (e) => {
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
                'aria-label': t`Xóa khoảng rảnh ${formatClock(r.from)}–${formatClock(r.to)}`,
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
          t('+ Thêm khoảng rảnh'),
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
    DURATIONS.map((d) => ({ id: d, label: d < 1 ? t('30 phút') : t`${d} giờ` })),
    state.hours,
    pickAndRender('hours'),
  );
  radioGroup($('scopes'), SCOPES, state.scope, pickAndRender('scope'));
  renderFreeRanges();

  // "Giờ bạn định đi" được chọn tự do trong các ngày đang xét, kể cả ngoài khoảng rảnh
  const choices = candidateStarts(s, { scope: state.scope, ranges: [{ from: 0, to: 24 }], hours: state.hours });
  if (!choices.includes(state.planned)) state.planned = null;
  $('planned').replaceChildren(
    el('option', { value: '' }, t('— Chưa chọn —')),
    ...choices.map((i) => {
      const { day, range } = windowLabel({ start: i, hours: state.hours });
      return el('option', { value: i, selected: i === state.planned }, `${day} ${range}`);
    }),
  );
  const decision = decideOutdoorPlan(s, { ...plannerOpts(), sensitive: profile.sensitive }, state.planned);
  const { mine, top, suggestions, outcome } = decision;
  const options = [...(mine ? [mine] : []), ...suggestions];
  if (state.shared?.chosen && state.selected != null && !options.some((w) => w.start === state.selected)) {
    const shared = describeOutdoorWindow(s, windowStats(s.pm25, state.selected, state.hours, act.ventilation), profile.sensitive);
    if (shared) options.push(shared);
  }
  if (!options.some((w) => w.start === state.selected)) state.selected = null;
  const requested = options.find((w) => w.start === state.selected);
  const selectedBlocked = requested && hasAvoid(requested.flags) ? requested : null;
  const pending = state.weatherStatus === 'loading';
  const chosen = pending || outcome === 'none' || selectedBlocked ? null : requested ?? (outcome === 'keep' ? mine : top);
  Object.assign(state, { best: pending ? [] : suggestions, mine, chosen });

  $('plan-summary').textContent = `${act.short} · ${state.hours < 1 ? t('30 phút') : t`${state.hours} giờ`}`;

  const out = [verdictCard(decision, pending)];
  if (state.weatherStatus === 'unavailable') {
    out.push(el('p', { class: 'status status--warn' }, t('Chưa tải được thời tiết. So sánh hiện dựa trên dữ liệu không khí; hãy kiểm tra mưa và nhiệt độ trước khi đi.')));
  }
  if (selectedBlocked && outcome !== 'none') {
    out.push(el('p', { class: 'status status--warn' }, t('Giờ đã chọn hiện có cảnh báo. Hãy chọn một giờ khác để lưu lịch.'), flagChips(selectedBlocked.flags)));
  }
  if (!pending && chosen) {
    out.push(chosenBar(chosen, mine));
    if (chosen.flags.length) {
      out.push(el('ul', { class: 'cond-tips' }, ...chosen.flags.map((f) => el('li', {}, el('span', { 'aria-hidden': 'true' }, f.icon), ' ', f.tip))));
    }
  }
  if (!pending && decision.skipped) {
    const { day, range } = windowLabel(decision.skipped);
    const why = decision.skipped.flags.filter((f) => f.severity === 'avoid').map((f) => f.label.toLowerCase()).join(', ');
    out.push(el('p', { class: 'muted small' }, t`${day} ${range} ít bụi hơn nhưng ${why} nên không được gợi ý.`));
  }
  if (mine || top) {
    out.push(el('a', { class: 'planner__chart-link', href: '#bieu-do', onclick: () => { $('chart-fold').open = true; } }, t('Xem các khung giờ trên biểu đồ ↓')));
  }

  const retrospective = lookBackNote(mine);
  if (retrospective) {
    out.push(el('details', { class: 'more' }, el('summary', {}, t('Nhìn lại PM2.5')), retrospective));
  }

  if (!pending && options.length > 1) {
    out.push(el(
      'details',
      { class: 'more', open: state.optionsOpen, ontoggle: (e) => { state.optionsOpen = e.target.open; } },
      el('summary', {}, t('Xem các giờ khác')),
      optionList({ options, mine, suggestions, chosen }),
    ));
  }

  const status = dataStatus(stationInfo());
  out.push(el('p', { class: `status status--${status.tone}` }, el('strong', {}, t('Độ tin cậy của dữ liệu: ')), status.text));
  out.push(correctionNote());

  const notes = [t`Phần trăm tính trên PM2.5 trung bình dự báo của cả khung. Hai khung chênh dưới ${SAME_REL * 100}% hoặc dưới ${SAME_ABS} µg/m³ được coi là tương đương.`];
  if (chosen && profile.id === 'adult') {
    notes.push(t`Ước tính ở khung đã chọn, người lớn hít vào khoảng ${int(chosen.dose)} µg bụi mịn (cường độ ${act.intensity}, ~${num(act.ventilation)} m³ không khí/giờ).`);
  } else if (chosen) {
    notes.push(t`Hồ sơ «${profile.short}» chỉ đổi lời khuyên và ngưỡng cảnh báo; số liệu bụi giữ nguyên. Không hiện ước tính µg hít vào vì hệ số thông khí là của người lớn.`);
  }
  out.push(el('details', { class: 'more' },
    el('summary', {}, localized('Cách tính mức chênh', 'How this comparison works')),
    el('p', { class: 'muted small' }, notes.join(' ')),
  ));
  $('results').replaceChildren(...out);
}

/** Một bên của phép so sánh: nhãn, giờ, ngày, PM2.5 trung bình dự báo, mức. */
function sideBox(tag, w, extraClass = '', scale = w.mean) {
  const { day, range } = windowLabel(w);
  return el(
    'div',
    { class: `duel__side ${extraClass}` },
    el('span', { class: 'duel__tag' }, tag),
    el('span', { class: 'duel__time' }, range),
    el('span', { class: 'duel__day' }, day),
    el('span', { class: 'duel__meter', 'aria-hidden': 'true' },
      el('span', { style: { width: scale > 0 ? `${100 * w.mean / scale}%` : '0%' } }),
    ),
    el('span', { class: 'duel__pm' }, `PM2.5 ${num(w.mean)} µg/m³ `, levelPill(levelForAqi(w.aqi), 'pill--sm')),
    flagChips(w.flags),
  );
}

/** Nhãn nhỏ cho mưa, nóng, UV, ozone của một khung. */
function flagChips(flags) {
  if (!flags?.length) return null;
  return el('span', { class: 'cond' }, ...flags.map((f) => el('span', { class: `cond__chip cond__chip--${f.severity}` }, `${f.icon} ${f.label}`)));
}

function verdictCard({ mine, mineBlocked, top, cmp, outcome, blocked, worstSuitable, hasAlternatives }, pending) {
  if (outcome === 'unavailable') {
    return el('p', { class: 'empty' }, t('Không còn giờ nào phù hợp trong các khoảng rảnh đã chọn. Thử chọn ngày khác hoặc nới khoảng rảnh.'));
  }

  const label = (window) => {
    const { day, range } = windowLabel(window);
    return { day: inlineDay(day), range };
  };
  const switchTime = top ? label(top) : null;
  const planTime = mine ? label(mine) : null;
  let title;
  let sub;
  let tone = '';
  let flags = null;
  if (pending) {
    title = t('Đang kiểm tra thời tiết');
    sub = t('Đã có dự báo không khí. ClearHour sẽ chốt gợi ý sau khi kiểm tra mưa, nhiệt độ và tia UV.');
    tone = ' verdict-card--pending';
  } else if (outcome === 'none') {
    title = t('Chưa có giờ phù hợp trong khoảng bạn rảnh');
    sub = t('Các khung có dữ liệu đều có cảnh báo mức nên tránh. Thử chọn ngày khác hoặc cân nhắc hoạt động trong nhà.');
    tone = ' verdict-card--caution';
    const visibleReasons = new Set(mine?.flags.filter((f) => f.severity === 'avoid').map((f) => f.id));
    const reasons = new Map();
    for (const window of blocked) {
      for (const flag of window.flags) {
        if (flag.severity === 'avoid' && !visibleReasons.has(flag.id)) reasons.set(flag.id, flag);
      }
    }
    flags = flagChips([...reasons.values()]);
  } else if (outcome === 'switch') {
    title = t`Nên dời sang ${switchTime.day} ${switchTime.range}`;
    sub = mineBlocked
      ? t('Giờ định đi có cảnh báo mức nên tránh. Khung gợi ý không có cảnh báo mức đó trong dữ liệu hiện có.')
      : [t('Bụi mịn dự báo thấp hơn '), el('strong', {}, `${cmp.pct}%`), t(' so với giờ bạn định đi.')];
  } else if (outcome === 'keep') {
    title = t`Giữ lịch cũ: ${planTime.day} ${planTime.range}`;
    sub = top
      ? t`Lúc rảnh ít bụi nhất (${switchTime.day} ${switchTime.range}) chỉ chênh ${num(Math.abs(cmp.diff))} µg/m³, không đáng để đổi lịch.`
      : hasAlternatives ? t('Các giờ rảnh phù hợp khác đều có PM2.5 dự báo cao hơn.') : t('Không có lúc rảnh nào khác để so sánh.');
  } else {
    title = t`Giờ gợi ý: ${switchTime.day} ${switchTime.range}`;
    const spread = worstSuitable ? reductionPct(top.mean, worstSuitable.mean) : 0;
    sub = [
      spread ? t`PM2.5 dự báo thấp hơn ${spread}% so với khung nhiều bụi nhất trong các giờ rảnh phù hợp (${windowLabel(worstSuitable).range}). ` : null,
      t('Chọn «Giờ bạn định đi» ở trên để biết đổi giờ giúp giảm bao nhiêu so với lịch của bạn.'),
    ];
  }

  const showTop = top && (pending || outcome === 'switch' || outcome === 'suggest');
  const scale = Math.max(mine?.mean ?? 0, showTop ? top.mean : 0);
  const topLabel = pending ? t('Khung đang xem') : t('Đề xuất');
  const hasComparison = mine || showTop;
  return el('div', { class: `verdict-card${tone}` },
    el('p', { class: 'verdict-card__title' }, title),
    el('p', { class: 'verdict-card__sub' }, sub),
    hasComparison ? el('div', { class: 'duel' },
      mine ? sideBox(t('Giờ bạn định đi'), mine, showTop || mineBlocked ? '' : 'duel__side--to', scale) : null,
      mine && showTop ? el('span', { class: 'duel__arrow', 'aria-hidden': 'true' }, '→') : null,
      showTop ? sideBox(topLabel, top, pending ? '' : 'duel__side--to', scale) : null,
    ) : null,
    flags,
  );
}

function optionList({ options, mine, suggestions, chosen }) {
  return el(
    'ul',
    { class: 'options', 'aria-label': t('Các lựa chọn để so sánh') },
    ...options.map((w) => {
      const { day, range } = windowLabel(w);
      const isMine = mine?.start === w.start;
      const isChosen = chosen?.start === w.start;
      const blocked = hasAvoid(w.flags);
      const rank = suggestions.indexOf(w) + 1;
      let delta = null;
      if (mine && !isMine) {
        const c = compareWithPlan(mine, w);
        delta = c.relation === 'same' ? t('gần tương đương giờ bạn định đi') : t`${c.relation === 'better' ? t('thấp') : localized('cao', 'higher')} hơn ${c.pct}% so với giờ bạn định đi`;
      }
      return el(
        'li',
        { class: `option${isChosen ? ' option--chosen' : ''}` },
        isMine
          ? el('span', { class: 'option__mark option__mark--plan', title: t('Giờ bạn định đi') })
          : el('span', { class: 'option__mark', title: rank ? t('Khung đề xuất') : t('Khung đã chia sẻ') }, rank || '↗'),
        el(
          'span',
          { class: 'option__main' },
          el('span', { class: 'option__time' }, `${day} · ${range}`),
          el(
            'span',
            { class: 'option__detail' },
            `${isMine ? t('Giờ bạn định đi · ') : ''}PM2.5 ${num(w.mean)} µg/m³ · ${levelForAqi(w.aqi).label}${delta ? ` · ${delta}` : ''}`,
          ),
          flagChips(w.flags),
        ),
        el(
          'button',
          {
            type: 'button',
            class: `btn btn--xs ${isChosen ? '' : 'btn--ghost'}`,
            'aria-pressed': String(isChosen),
            disabled: blocked,
            'aria-label': t`Chọn khung ${inlineDay(day)} ${range}`,
            onclick: () => {
              if (state.selected !== w.start) state.shared = null;
              state.selected = w.start;
              renderAll();
              document.querySelector('.option button[aria-pressed="true"]')?.focus({ preventScroll: true });
            },
          },
          blocked ? t('Nên tránh') : isChosen ? t('✓ Đã chọn') : t('Chọn'),
        ),
      );
    }),
  );
}

/** Hành động sau quyết định: đưa khung đã chọn vào lịch hoặc gửi cho nhóm. */
function chosenBar(chosen, mine) {
  const { day, range } = windowLabel(chosen);
  const head = el('p', { class: 'chosen__label' }, t('Khung đã chọn: '), el('strong', {}, `${inlineDay(day)} ${range}`));
  if (isSample()) {
    return el('div', { class: 'chosen' }, head, el('p', { class: 'muted small' }, t('Đây là lịch minh họa từ dữ liệu mẫu nên không xuất ra lịch hay tin nhắn.')));
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
      el('a', { class: 'btn btn--xs', href: googleCalendarUrl(ev), target: '_blank', rel: 'noopener' }, t('📅 Thêm vào Google Lịch')),
      el('button', { type: 'button', class: 'btn btn--ghost btn--xs', onclick: () => downloadIcs(ev, ev.fileName) }, t('⬇ Tệp lịch .ics')),
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
        t('💬 Sao chép tin nhắn rủ nhóm'),
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
      el('span', { class: 'vent__label' }, t('Giờ thông gió tốt nhất')),
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
    const label = slots.some((slot) => Number.isFinite(slot.pm25))
      ? localized('Chưa thấy giờ thông gió phù hợp trong dự báo 24 giờ tới.', 'The 24-hour forecast shows no suitable time to ventilate.')
      : localized('Chưa có dữ liệu để gợi ý giờ thông gió.', 'There’s no forecast data for ventilation advice.');
    head.push(el('span', { class: 'vent__label' }, label));
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
  $('vent-strip').setAttribute('aria-label', t`Trạng thái mở cửa sổ theo giờ trong ${slots.length} giờ tới`);
  $('vent-axis').replaceChildren(
    ...slots.map((sl, k) => {
      const h = hourOf(sl.time);
      const label = k === 0 ? t('Bây giờ') : k > 3 && h % 3 === 0 ? `${String(h).padStart(2, '0')}h` : '';
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
    const d0 = inlineDay(dayName(datePart(t0)));
    const d1 = inlineDay(dayName(datePart(t1)));
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
    (profile.sensitive ? t`Nhà có ${profile.short.toLowerCase()}: chỉ nên mở cửa trong các giờ màu xanh. ` : '') +
    t('Khi mở, mở hai cửa đối diện 10–15 phút để không khí lưu thông nhanh. Khi đóng, hạn chế đốt nhang và chiên rán, bật máy lọc có màng HEPA nếu có.');
}

function renderForecastInsight(series, start, end) {
  let low = -1;
  let high = -1;
  for (let i = Math.max(series.nowIndex, start); i < end; i++) {
    const value = series.pm25[i];
    if (!Number.isFinite(value)) continue;
    if (low < 0 || value < series.pm25[low]) low = i;
    if (high < 0 || value > series.pm25[high]) high = i;
  }
  const slot = (label, index) => {
    const time = series.times[index];
    return el('div', { class: 'chart-insight__slot' },
      el('span', { class: 'muted' }, label),
      el('strong', { class: 'chart-insight__time' }, `${time.slice(11, 16)} · ${shortDate(datePart(time))}`),
      el('span', {}, `PM2.5 ${num(series.pm25[index])} µg/m³`),
    );
  };
  $('chart-insight').replaceChildren(...(low < 0 ? [] : [
    slot(localized('Thấp nhất trong các giờ sắp tới', 'Lowest in the upcoming hours shown'), low),
    ...(high !== low ? [slot(localized('Cao nhất trong các giờ sắp tới', 'Highest in the upcoming hours shown'), high)] : []),
  ]));
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
  const hasOriginal = s.pm25Raw?.slice(start, end).some(Number.isFinite) === true;
  $('chart-layer').hidden = !hasOriginal;
  const showOriginal = hasOriginal && $('show-cams-original').checked;
  const sensitive = profileOf().sensitive;
  renderForecastInsight(s, start, end);
  const warningRows = renderChart($('chart-scroll'), $('chart-hour'), {
    series: s,
    start,
    end,
    windows: state.best.map((w, i) => ({ start: w.start, hours: w.hours, rank: i + 1, selected: w.start === chosen })),
    selected: state.chosen,
    planned: state.mine,
    showOriginal,
    sensitive,
    dayText: (d) => t`${weekday(d)} ${shortDate(d)} · TB ngày ${num(dailyMean(s, d))}`,
  });
  $('chart-sub').textContent =
    (state.chartRange === 'day' ? first === last ? `${dayWithDate(first)}.` : t`Từ ${shortDate(first)} đến ${shortDate(last)}.` : t('72 giờ tới.')) +
    t(' Màu cột thể hiện VN_AQI tính riêng từ PM2.5. Cột mờ là giờ đã qua.') +
    (s.corrected ? t(' Cột dùng PM2.5 đã hiệu chỉnh.') : '');
  renderLegend(warningRows, showOriginal);

  const rows = [];
  for (let i = s.nowIndex; i < Math.min(s.times.length, s.nowIndex + 72); i++) {
    const time = s.times[i];
    const aqi = aqiFromConcentration(s.pm25[i], 'pm2_5');
    const level = levelForAqi(aqi);
    rows.push(
      el(
        'tr',
        {},
        el('td', {}, `${weekday(datePart(time))} ${shortDate(datePart(time))} ${time.slice(11, 16)}`),
        el('td', {}, num(s.pm25[i])),
        showOriginal ? el('td', {}, num(s.pm25Raw[i])) : null,
        el('td', {}, num(s.pm10[i])),
        el('td', {}, int(aqi)),
        el('td', {}, level ? level.label : '–'),
        el('td', {}, chartHourFlags(s, i, sensitive).map((flag) =>
          `${flag.label} (${flag.severity === 'avoid' ? t('Nên tránh') : t('Lưu ý')})`
        ).join(' · ') || '–'),
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
        el('tr', {}, ...[t('Thời gian'), 'PM2.5 (µg/m³)', ...(showOriginal ? [t('CAMS gốc (µg/m³)')] : []), 'PM10 (µg/m³)', 'VN_AQI (PM2.5)', t('Mức'), t('Cảnh báo')].map((h) => el('th', { scope: 'col' }, h))),
      ),
      el('tbody', {}, rows),
    ),
  );

  $('grid-note').textContent =
    t`«TB ngày» là PM2.5 trung bình 24 giờ theo dự báo; WHO khuyến nghị mức này không quá ${WHO_PM25_24H} µg/m³. ` +
    t`Ô lưới mô hình gần nhất: ${num(s.gridLat)}°N, ${num(s.gridLon)}°E (CAMS toàn cầu, ~45 km). Giờ địa phương (${s.timezone}). ` +
    t('Chỉ số theo từng giờ được quy đổi trực tiếp từ nồng độ dự báo, không dùng Nowcast như trạm quan trắc.');
}

function renderLegend(rows = [], showOriginal = false) {
  $('legend').replaceChildren(...[
    ...LEVELS.map((l) => el('li', {}, el('i', { style: { background: l.display } }), l.label)),
    el('li', {}, el('i', { class: 'mark' }, '1'), t('Khung đề xuất')),
    el('li', {}, el('i', { class: 'mark mark--plan' }), t('Giờ bạn định đi')),
    showOriginal ? el('li', {}, el('i', { class: 'chart-original-key', 'aria-hidden': 'true' }), t('CAMS gốc')) : null,
    rows.length ? el('li', { class: 'legend__break' }, el('span', { class: 'chart-legend--avoid', 'aria-hidden': 'true' }, '▲'), t('Nên tránh')) : null,
    rows.length ? el('li', {}, el('span', { class: 'chart-legend--warn', 'aria-hidden': 'true' }, '●'), t('Lưu ý')) : null,
    ...rows.map((row) => el('li', {}, el('span', { 'aria-hidden': 'true' }, row.icon), row.label)),
  ].filter(Boolean));
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
        if (key === 'name' && ev.target.value) slot.customName = true;
        slot[key] = ev.target.value || slot[key];
        if (parseClock(slot.to) <= parseClock(slot.from)) slot.to = formatClock(Math.min(24, parseClock(slot.from) + 1));
        saveSlots();
        renderOrgPlan();
      };
      return el(
        'tr',
        {},
        el('td', {}, el('input', { type: 'text', value: displaySlotName(slot), 'aria-label': t('Tên hoạt động'), onchange: update('name') })),
        el('td', {}, el('input', { type: 'time', value: slot.from, step: 900, 'aria-label': t('Bắt đầu'), onchange: update('from') })),
        el('td', {}, el('input', { type: 'time', value: slot.to, step: 900, 'aria-label': t('Kết thúc'), onchange: update('to') })),
        el(
          'td',
          {},
          el(
            'button',
            {
              type: 'button',
              class: 'btn btn--icon',
              'aria-label': t`Xóa ${displaySlotName(slot)}`,
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
  const counts = { ok: 0, caution: 0, stop: 0 };

  const head = el('tr', {}, el('th', { scope: 'col' }, t('Hoạt động')), ...days.map((d) => el('th', { scope: 'col' }, dayWithDate(d))));
  const body = slots.map((slot) =>
    el(
      'tr',
      {},
      el('th', { scope: 'row' }, el('div', {}, displaySlotName(slot)), el('div', { class: 'verdict__meta' }, `${slot.from}–${slot.to}`)),
      ...days.map((d) => {
        if (slotPassed(d, slot)) return el('td', { class: 'muted small' }, t('Đã qua'));
        const v = evaluateSlot(s, d, slot, state.orgType);
        if (!v) return el('td', { class: 'muted small' }, t('Chưa có dữ liệu'));
        counts[v.status] += 1;
        return el(
          'td',
          {},
          el(
            'div',
            { class: `verdict verdict--${v.status}` },
            el('span', { class: 'verdict__head' }, el('span', { 'aria-hidden': 'true' }, STATUS_ICON[v.status]), v.text),
            el('span', { class: 'verdict__meta' }, t`PM2.5 cao nhất ${num(v.peak)}, trung bình ${num(v.mean)} µg/m³ · ${v.level.label}`),
          ),
        );
      }),
    ),
  );
  const table = el('table', {}, el('thead', {}, head), el('tbody', {}, body));
  $('org-grid').replaceChildren(table);
  $('print-org').disabled = !slots.length || state.weatherStatus === 'loading';
  renderOrgPrintReport(table, slots, counts);
  $('notice').textContent = buildNotice(days, slots);
  renderOrgHistory();
}

function renderOrgPrintReport(table, slots, counts) {
  const series = state.series;
  const reference = series.times[series.nowIndex];
  const type = ORG_TYPES.find((item) => item.id === state.orgType).label;
  const source = isSample() ? t('Dữ liệu mẫu Hà Nội') : series.corrected
    ? t`Dự báo CAMS, PM2.5 hiệu chỉnh theo trạm ${series.corrected.name}` : t('Dự báo CAMS gốc');
  const summary = [
    [counts.ok, t('Giữ lịch')],
    [counts.caution, t('Cần điều chỉnh')],
    [counts.stop, t('Dừng hoạt động ngoài trời')],
  ];
  const history = state.historyView;
  const recent = history && !isSample() ? slots.map((slot) => {
    const { days, counts: tally } = slotHistory(history, slot, state.orgType, { today: todayStr() });
    return days ? el('li', {},
      el('strong', {}, displaySlotName(slot)),
      t` · ${tally.ok}/${days} ngày có thể giữ lịch theo mô hình.`,
    ) : null;
  }).filter(Boolean) : [];
  $('org-print-report').replaceChildren(...[
    el('header', { class: 'org-print-report__header' },
      el('p', { class: 'org-print-report__brand' }, 'ClearHour'),
      el('h1', { id: 'print-title' }, t('Báo cáo lịch hoạt động ngoài trời')),
      el('p', {}, `${type} · ${placeName()}`),
      el('p', {}, t`Giờ tham chiếu ${reference.slice(11, 16)} ngày ${shortDate(datePart(reference), true)} (${series.timezone}).`),
      el('p', { class: 'org-print-report__source' }, source),
      state.weatherStatus === 'unavailable' ? el('p', {}, t('Chưa có dự báo thời tiết. Hãy kiểm tra mưa và nhiệt độ trước khi đi.')) : null,
    ),
    el('dl', { class: 'org-print-report__summary' }, ...summary.map(([value, label]) =>
      el('div', {}, el('dt', {}, label), el('dd', {}, int(value))),
    )),
    table.cloneNode(true),
    recent.length ? el('section', { class: 'org-print-report__history' },
      el('h2', {}, t('Nhìn lại tối đa 30 ngày theo mô hình')),
      el('p', {}, t('Thống kê dựa trên PM2.5 và O₃ khi có dữ liệu.')),
      el('ul', {}, recent),
    ) : null,
    el('footer', {}, t('Nguồn: ClearHour – dự báo CAMS/Open-Meteo, chỉ số VN_AQI theo QĐ 1459/QĐ-TCMT. Thông tin mang tính tham khảo.')),
  ].filter(Boolean));
}

/** Nhìn lại 30 ngày cho trường học, doanh nghiệp: giờ thường sạch và số ngày ổn của từng khung. */
function renderOrgHistory() {
  const box = $('org-history');
  const h = state.historyView;
  const today = state.series ? todayStr() : null;
  const grid = h && !isSample() ? cleanGrid(h, { today, fromHour: 5, toHour: 22 }) : null;
  box.hidden = !grid?.rows.length;
  if (box.hidden) return;
  const n = grid.rows.length;
  const slots = state.slots[state.orgType];
  const out = [];

  if (slots.length) {
    const from = Math.min(...slots.map((x) => Math.floor(parseClock(x.from))));
    const to = Math.max(...slots.map((x) => Math.ceil(parseClock(x.to))));
    const best = cleanestHour(grid, from, Math.max(to, from + 1));
    if (best) {
      out.push(el(
        'p',
        { class: 'org-history__best' },
        t`Trong khung ${formatClock(from)}–${formatClock(to)}, giờ thường sạch nhất là `,
        el('strong', {}, `${formatClock(best.hour)}–${formatClock(best.hour + 1)}`),
        t`: ${best.clean}/${best.days} ngày ở mức Tốt hoặc Trung bình. `,
        state.orgType === 'school' ? t('Có thể cân nhắc xếp các tiết ngoài trời cố định vào giờ này.') : t('Có thể ưu tiên việc ngoài trời vào giờ này.'),
      ));
    }
    const colors = { ok: LEVELS[0].display, caution: LEVELS[2].display, stop: LEVELS[3].display };
    out.push(el(
      'ul',
      { class: 'slot-hist' },
      ...slots.map((slot) => {
        const r = slotHistory(h, slot, state.orgType, { today });
        if (!r.days) return null;
        return el(
          'li',
          {},
          el('span', { class: 'slot-hist__name' }, `${displaySlotName(slot)} · ${slot.from}–${slot.to}`),
          el('span', { class: 'slot-hist__bar', 'aria-hidden': 'true' },
            ...['ok', 'caution', 'stop'].map((k) => (r.counts[k] ? el('span', { style: { flexGrow: r.counts[k], background: colors[k] } }) : null)),
          ),
          el('span', { class: 'slot-hist__text' }, t`${STATUS_ICON.ok} ${r.counts.ok} ngày ổn · ${STATUS_ICON.caution} ${r.counts.caution} ngày cần điều chỉnh · ${STATUS_ICON.stop} ${r.counts.stop} ngày nên dừng ngoài trời`),
        );
      }),
    ));
  }

  const seen = new Set();
  const heat = el(
    'div',
    { class: 'heat', role: 'img', 'aria-label': t`Mức VN_AQI từng giờ từ 5:00 đến 22:00 trong ${n} ngày qua, mỗi hàng là một ngày` },
    ...grid.rows.flatMap((r, k) => [
      el('span', { class: 'heat__day' }, k % 7 === 0 || (k === n - 1 && k % 7 >= 3) ? shortDate(r.day) : ''),
      ...r.cells.map((v, c) => {
        const level = v == null ? null : levelForAqi(v);
        if (level) seen.add(level);
        return el('span', {
          class: 'heat__cell',
          style: { background: level?.display ?? 'transparent' },
          title: level ? `${shortDate(r.day)} ${formatClock(grid.hours[c])} · ${level.label}` : null,
        });
      }),
    ]),
    el('span', { class: 'heat__day' }),
    ...grid.hours.map((hh) => el('span', { class: 'heat__hour' }, hh % 3 === 2 ? `${hh}h` : '')),
  );
  out.push(
    el('p', { class: 'muted small' }, t`Mỗi hàng là một ngày, mỗi ô là một giờ từ 5:00 đến 22:00 tại ${placeName()}, tô màu theo mức VN_AQI (gồm bụi mịn và ozone).`),
    heat,
    el('div', { class: 'heat__legend' }, ...LEVELS.filter((l) => seen.has(l)).map((l) => el('span', {}, el('i', { style: { background: l.display } }), l.label))),
    el('p', { class: 'muted small' }, t('Tính trên dữ liệu mô hình của 30 ngày qua (đã hiệu chỉnh theo trạm nếu có). Giờ sạch thay đổi theo mùa, nên xem lại mỗi tháng.')),
  );
  $('org-history-body').replaceChildren(...out);
}

function buildNotice(days, slots) {
  const s = state.series;
  const now = s.times[s.nowIndex];
  const lines = [
    state.orgType === 'school' ? t('Kính gửi quý phụ huynh và các em học sinh,') : t('Gửi anh chị em làm việc ngoài trời,'),
    '',
    t`📢 LỊCH HOẠT ĐỘNG NGOÀI TRỜI THEO DỰ BÁO BỤI MỊN – ${isSample() ? t('Hà Nội (dữ liệu mẫu)') : placeName()}`,
    t`(Cập nhật ${now.slice(11, 16)} ngày ${shortDate(datePart(now))})`,
  ];
  for (const d of days) {
    lines.push('', `${dayWithDate(d)}:`);
    for (const slot of slots) {
      if (slotPassed(d, slot)) continue;
      const v = evaluateSlot(s, d, slot, state.orgType);
      if (!v) continue;
      lines.push(t`• ${displaySlotName(slot)} (${slot.from}–${slot.to}): ${STATUS_ICON[v.status]} ${v.text} – PM2.5 cao nhất ~${num(v.peak)} µg/m³ (${v.level.label})`);
    }
  }
  lines.push('', t('Nguồn: ClearHour – dự báo CAMS/Open-Meteo, chỉ số VN_AQI theo QĐ 1459/QĐ-TCMT. Thông tin mang tính tham khảo.'));
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
    weatherUnavailable: state.weatherStatus === 'unavailable',
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
  city.replaceChildren(...CITIES.map((c) => el('option', { value: c.id, selected: c.id === state.cityId }, t(c.name))));
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
        state.myPlace = { name: t('Vị trí của bạn'), lat: pos.coords.latitude, lon: pos.coords.longitude };
        state.demo = false;
        state.shared = null;
        showCustomPlace();
        load();
      },
      (err) => {
        const banner = $('banner');
        banner.textContent = t`Không lấy được vị trí của bạn (${err.message}). Hãy chọn thành phố trong danh sách.`;
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
  $('show-cams-original').addEventListener('change', () => {
    if (state.series) renderChartSection();
  });
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
    state.slots[state.orgType].push({ name: NEW_SLOT_NAME, from: '08:00', to: '09:00' });
    saveSlots();
    renderOrg();
  });
  $('copy-notice').addEventListener('click', copyNotice);
  $('print-org').addEventListener('click', () => {
    document.body.classList.add('org-printing');
    window.print();
  });
  window.addEventListener('afterprint', () => document.body.classList.remove('org-printing'));

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => state.series && $('chart-fold').open && renderChartSection(), 150);
  });

  renderLegend();
}

localizeShell();
initControls();
load().then(() => {
  if (location.hash === '#cau-chuyen' && state.series && !$('app').classList.contains('is-loading') && state.weatherStatus !== 'loading') startStory();
});
fetchStations().then((list) => {
  state.stations = list;
  if (state.series && !$('app').classList.contains('is-loading')) renderAll();
});
fetchAccuracy().then((doc) => {
  state.accuracy = doc;
  if (!state.rawSeries || $('app').classList.contains('is-loading')) return;
  deriveSeries();
  renderAll();
});
