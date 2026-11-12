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
import { ageText, compareWithModel, fetchStations, nearestStation, toLocalTime } from './stations.js';
import { addDays, datePart, dayLabel, formatClock, hourOf, parseClock, shortDate, weekday } from './time.js';

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
    ...Array.from({ length: to - from + 1 }, (_, k) => from + k).map((h) => el('option', { value: h, selected: h === value }, formatClock(h))),
  );
}

function levelPill(level, extra = '') {
  return el('span', { class: `pill ${extra}`, style: { background: level.display, color: level.ink } }, level.label);
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
  renderChartSection();
  renderVentilation();
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
  const pair = `${num(info.st.pm25)} so với ${num(info.model)} µg/m³, số đo ${info.age}`;
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
  if (!options.some((w) => w.start === state.selected)) state.selected = null;
  const chosen = options.find((w) => w.start === state.selected) ?? (mine && !shouldSwitch ? mine : top);
  Object.assign(state, { best: suggestions, mine, chosen });

  const free = state.free.map((r) => `${formatClock(r.from)}–${formatClock(r.to)}`).join(', ');
  $('plan-summary').replaceChildren(
    `Đang tính cho: ${act.icon} ${act.short} · ${state.hours < 1 ? '30 phút' : `${state.hours} giờ`} · lúc rảnh ${free} · `,
    el('a', { href: '#dieu-chinh' }, 'Điều chỉnh'),
  );

  const out = [];
  if (!options.length) {
    out.push(el('p', { class: 'empty' }, 'Không còn giờ nào phù hợp trong các khoảng rảnh đã chọn. Thử chọn ngày khác hoặc nới khoảng rảnh.'));
  } else {
    out.push(verdictCard({ mine, top, cmp, shouldSwitch, worst, hasOthers: others.length > 0 }));
    if (options.length > 1) out.push(optionList({ options, mine, suggestions, chosen }));
    out.push(chosenBar(chosen, mine));

    const level = levelForAqi(chosen.aqi);
    if (chosen.aqi > (profile.sensitive ? 100 : 150)) {
      out.push(el('p', { class: 'warn' }, `Khung đã chọn vẫn ở mức ${level.label}. ${level.advice[profile.sensitive ? 'sensitive' : 'normal']}`));
    }
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
    el('span', { class: 'duel__pm' }, `${num(w.mean)} µg/m³ `, levelPill(levelForAqi(w.aqi), 'pill--sm')),
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
      const isChosen = chosen.start === w.start;
      let delta = null;
      if (mine && !isMine) {
        const c = compareWithPlan(mine, w);
        delta = c.relation === 'same' ? 'gần tương đương giờ bạn định đi' : `thấp hơn ${c.pct}% so với giờ bạn định đi`;
      }
      return el(
        'li',
        { class: `option${isChosen ? ' option--chosen' : ''}` },
        isMine
          ? el('span', { class: 'option__mark option__mark--plan', title: 'Giờ bạn định đi' })
          : el('span', { class: 'option__mark', title: 'Khung đề xuất' }, suggestions.indexOf(w) + 1),
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

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => state.series && renderChartSection(), 150);
  });

  renderLegend();
}

initControls();
load();
fetchStations().then((list) => {
  state.stations = list;
  if (state.series) renderAll();
});
