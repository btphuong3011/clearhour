import { aqiFromConcentration, cigarettesPerDay, combinedAqi, LEVELS, levelForAqi, nowcast, WHO_PM25_24H } from './aqi.js';
import { fetchAirQuality, fetchSample } from './api.js';
import { downloadIcs, googleCalendarUrl, localToUtc } from './calendar.js';
import { renderChart } from './chart.js';
import { CITIES } from './cities.js';
import { el, int, num } from './format.js';
import {
  ACTIVITIES,
  dailyMean,
  DURATIONS,
  evaluateSlot,
  findBestWindows,
  ORG_PRESETS,
  PROFILES,
  reductionPct,
  VENT_STATUSES,
  ventilationPlan,
  windowStats,
} from './planner.js';
import { fetchStations, nearestStation } from './stations.js';
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
const STATUS_ICON = { ok: '✅', caution: '⚠️', stop: '⛔' };

const params = new URLSearchParams(location.search);
const pick = (value, list, fallback) => (list.some((x) => x.id === value) ? value : fallback);

const state = {
  cityId: pick(params.get('city') ?? store.get('city', 'hanoi'), CITIES, 'hanoi'),
  myPlace: null,
  profile: pick(params.get('profile') ?? store.get('profile', 'adult'), PROFILES, 'adult'),
  activity: pick(params.get('activity') ?? 'run', ACTIVITIES, 'run'),
  hours: DURATIONS.includes(Number(params.get('dur'))) ? Number(params.get('dur')) : 1,
  scope: pick(params.get('scope'), SCOPES, 'today'),
  scopeFromUrl: params.has('scope'),
  fromHour: 5,
  toHour: 22,
  planned: null,
  orgType: pick(params.get('org'), ORG_TYPES, 'school'),
  slots: store.get('slots', null) ?? {
    school: structuredClone(ORG_PRESETS.school.slots),
    business: structuredClone(ORG_PRESETS.business.slots),
  },
  series: null,
  best: [],
  stations: [],
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

function levelPill(level, extra = '') {
  return el('span', { class: `pill ${extra}`, style: { background: level.display, color: level.ink } }, level.label);
}

function place() {
  return state.myPlace ?? CITIES.find((c) => c.id === state.cityId);
}

function todayStr() {
  return datePart(state.series.times[state.series.nowIndex]);
}

function windowLabel(w) {
  const t = state.series.times[w.start];
  const h = hourOf(t);
  return {
    day: dayLabel(datePart(t), todayStr()),
    range: `${formatClock(h)}–${formatClock(h + w.hours)}`,
  };
}

function placeName() {
  return state.series.source === 'sample' ? 'Hà Nội' : place().name;
}

function calendarEvent(w) {
  const s = state.series;
  const act = ACTIVITIES.find((a) => a.id === state.activity);
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

function syncUrl() {
  const p = new URLSearchParams();
  if (!state.myPlace) p.set('city', state.cityId);
  p.set('profile', state.profile);
  p.set('activity', state.activity);
  p.set('dur', state.hours);
  p.set('scope', state.scope);
  history.replaceState(null, '', `${location.pathname}?${p}${location.hash}`);
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
  if (!state.scopeFromUrl && state.scope === 'today' && !hasCandidatesToday()) state.scope = 'tomorrow';
  main.classList.remove('is-loading');
  renderAll();
}

function hasCandidatesToday() {
  const act = ACTIVITIES.find((a) => a.id === state.activity);
  return findBestWindows(state.series, { scope: 'today', fromHour: state.fromHour, toHour: state.toHour, hours: state.hours, ventilation: act.ventilation }).best.length > 0;
}

// ---------- Render ----------

function renderAll() {
  if (!state.series) return;
  renderMeta();
  renderNow();
  renderPlanner();
  renderVentilation();
  renderChartSection();
  renderOrg();
  syncUrl();
}

function renderMeta() {
  const s = state.series;
  const now = s.times[s.nowIndex];
  const last = s.times[s.times.length - 1];
  $('updated').textContent =
    s.source === 'sample'
      ? 'Dữ liệu mẫu'
      : `Dữ liệu lúc ${now.slice(11, 16)} ${shortDate(datePart(now))} · dự báo đến ${weekday(datePart(last))} ${shortDate(datePart(last))}`;
  $('now-place').textContent = `${s.source === 'sample' ? 'Hà Nội (mẫu)' : place().name} · ${now.slice(11, 16)}`;
}

function renderNow() {
  const s = state.series;
  const back = (arr) => Array.from({ length: 12 }, (_, k) => arr[s.nowIndex - k] ?? null);
  const pm25Now = nowcast(back(s.pm25));
  const pm10Now = nowcast(back(s.pm10));
  const aqi = combinedAqi({ pm2_5: pm25Now, pm10: pm10Now });
  const level = levelForAqi(aqi);
  $('now-aqi').textContent = int(aqi);
  const pill = $('now-level');
  pill.textContent = level?.label ?? '–';
  pill.style.background = level?.display ?? '';
  pill.style.color = level?.ink ?? '';

  $('now-pm25').textContent = num(s.current.pm25 ?? s.pm25[s.nowIndex]);
  const mean = dailyMean(s, todayStr());
  const ratio = mean / WHO_PM25_24H;
  $('now-who').replaceChildren(
    ratio > 1 ? `gấp ${num(ratio)} lần` : 'Dưới ngưỡng',
    el('small', { class: 'sub' }, `TB hôm nay ${num(mean)} µg/m³`),
  );
  $('now-cig').textContent = num(cigarettesPerDay(mean));
  renderStation();

  radioGroup($('profiles'), PROFILES, state.profile, (id) => {
    state.profile = id;
    store.set('profile', id);
    renderAll();
  }, { chip: true });

  const profile = PROFILES.find((p) => p.id === state.profile);
  const advice = level ? level.advice[profile.sensitive ? 'sensitive' : 'normal'] : '';
  $('now-advice').replaceChildren(
    el('strong', {}, `${profile.short}: `),
    advice,
    profile.sensitive ? ' (thuộc nhóm nhạy cảm theo QĐ 1459)' : '',
  );
}

/** Đối chiếu dự báo mô hình với số đo của trạm gần nhất (nếu có dữ liệu trạm). */
function renderStation() {
  const s = state.series;
  const row = $('station-row');
  if (s.source === 'sample' || !state.stations.length) {
    row.hidden = true;
    return;
  }
  row.hidden = false;
  const p = place();
  const st = nearestStation(state.stations, p.lat, p.lon);
  if (!st) {
    $('station-meta').textContent = 'Không có số đo mới trong bán kính 30 km';
    $('station-val').replaceChildren('–');
    return;
  }
  const localTime = new Date(Date.parse(st.time) + s.utcOffsetSeconds * 1000).toISOString().slice(11, 16);
  $('station-meta').textContent = `${st.name} · cách ${num(st.km)} km · ${localTime}${st.isMonitor ? '' : ' · cảm biến giá rẻ'}`;
  $('station-val').replaceChildren(
    num(st.pm25),
    ' ',
    el('small', {}, 'µg/m³'),
    el('small', { class: 'sub' }, `mô hình dự báo: ${num(s.pm25[s.nowIndex])}`),
  );
}

function renderPlanner() {
  const s = state.series;
  const act = ACTIVITIES.find((a) => a.id === state.activity);
  const profile = PROFILES.find((p) => p.id === state.profile);

  radioGroup($('activities'), ACTIVITIES, state.activity, (id) => {
    state.activity = id;
    state.planned = null;
    renderAll();
  }, { chip: true });
  radioGroup(
    $('durations'),
    DURATIONS.map((d) => ({ id: d, label: d < 1 ? '30 phút' : `${d} giờ` })),
    state.hours,
    (id) => {
      state.hours = id;
      state.planned = null;
      renderAll();
    },
  );
  radioGroup($('scopes'), SCOPES, state.scope, (id) => {
    state.scope = id;
    state.planned = null;
    renderAll();
  });

  const opts = { scope: state.scope, fromHour: state.fromHour, toHour: state.toHour, hours: state.hours, ventilation: act.ventilation };
  const { best, worst, all } = findBestWindows(s, opts, 3);
  state.best = best;

  // Danh sách giờ để so sánh
  const planned = $('planned');
  if (!all.some((w) => w.start === state.planned)) state.planned = null;
  planned.replaceChildren(
    el('option', { value: '' }, '— Chọn giờ —'),
    ...all
      .slice()
      .sort((a, b) => a.start - b.start)
      .map((w) => {
        const { day, range } = windowLabel(w);
        return el('option', { value: w.start, selected: w.start === state.planned }, `${day} ${range}`);
      }),
  );

  const out = [];
  if (!best.length) {
    out.push(el('p', { class: 'empty' }, 'Không còn khung giờ phù hợp trong khoảng đã chọn. Thử chọn "Ngày mai" hoặc nới rộng khung giờ.'));
  } else {
    best.forEach((w, idx) => {
      const { day, range } = windowLabel(w);
      const level = levelForAqi(w.aqi);
      const detail = [`PM2.5 trung bình ${num(w.mean)} µg/m³`, `hít vào ~${int(w.dose)} µg bụi mịn`];
      if (idx === 0 && worst && worst.start !== w.start) {
        const wl = windowLabel(worst);
        detail.push(`ít hơn ${reductionPct(w.mean, worst.mean)}% so với khung tệ nhất (${wl.day.toLowerCase()} ${wl.range})`);
      }
      const ev = calendarEvent(w);
      out.push(
        el(
          'div',
          { class: `window${idx === 0 ? ' window--best' : ''}` },
          el('span', { class: 'window__rank', 'aria-label': `Hạng ${idx + 1}` }, idx + 1),
          el('span', { class: 'window__time' }, `${day} · ${range}`),
          el('span', { class: 'window__level' }, levelPill(level, 'pill--sm')),
          el('span', { class: 'window__detail' }, detail.join(' · ')),
          el(
            'span',
            { class: 'window__actions' },
            el(
              'a',
              {
                class: 'btn btn--ghost btn--xs',
                href: googleCalendarUrl(ev),
                target: '_blank',
                rel: 'noopener',
                'aria-label': `Thêm khung ${day.toLowerCase()} ${range} vào Google Lịch`,
              },
              '📅 Google Lịch',
            ),
            el(
              'button',
              {
                type: 'button',
                class: 'btn btn--ghost btn--xs',
                'aria-label': `Tải tệp lịch .ics cho khung ${day.toLowerCase()} ${range}`,
                onclick: () => downloadIcs(ev, ev.fileName),
              },
              '⬇ Tệp lịch .ics',
            ),
          ),
        ),
      );
    });

    if (state.planned != null) {
      const mine = windowStats(s.pm25, state.planned, state.hours, act.ventilation);
      const top = best[0];
      const { day, range } = windowLabel(mine);
      if (mine.start === top.start || mine.mean <= top.mean) {
        out.push(el('p', { class: 'compare' }, `Giờ bạn định đi (${day.toLowerCase()} ${range}) đã là khung tốt nhất. 👍`));
      } else {
        const tl = windowLabel(top);
        out.push(
          el(
            'p',
            { class: 'compare' },
            `Nếu đi ${day.toLowerCase()} ${range}: hít vào ~${int(mine.dose)} µg. Dời sang ${tl.day.toLowerCase()} ${tl.range} `,
            el('strong', {}, `giảm ${reductionPct(top.dose, mine.dose)}%`),
            ' lượng bụi mịn hít vào.',
          ),
        );
      }
    }

    const bestLevel = levelForAqi(best[0].aqi);
    const threshold = profile.sensitive ? 100 : 150;
    if (best[0].aqi > threshold) {
      out.push(
        el(
          'p',
          { class: 'warn' },
          `Ngay cả khung tốt nhất cũng ở mức ${bestLevel.label}. ${bestLevel.advice[profile.sensitive ? 'sensitive' : 'normal']}`,
        ),
      );
    }
  }
  out.push(
    el(
      'p',
      { class: 'muted small' },
      `Ước tính cho hoạt động cường độ ${act.intensity} (~${num(act.ventilation)} m³ không khí/giờ).`,
    ),
  );
  $('results').replaceChildren(...out);
}

function renderVentilation() {
  const s = state.series;
  const today = todayStr();
  const profile = PROFILES.find((p) => p.id === state.profile);
  const { slots, runs, best } = ventilationPlan(s, 24);
  const at = (i) => `${dayLabel(datePart(s.times[i]), today)} ${s.times[i].slice(11, 16)}`;

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
    const d0 = dayLabel(datePart(t0), today).toLowerCase();
    const d1 = dayLabel(datePart(t1), today).toLowerCase();
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
  const start = Math.max(0, s.nowIndex - 6);
  const end = Math.min(s.times.length, s.nowIndex + 72);
  renderChart($('chart-scroll'), $('tooltip'), {
    series: s,
    start,
    end,
    windows: state.best.map((w, i) => ({ start: w.start, hours: w.hours, rank: i + 1 })),
  });

  const rows = [];
  for (let i = s.nowIndex; i < end; i++) {
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
    `Ô lưới mô hình gần nhất: ${num(s.gridLat)}°N, ${num(s.gridLon)}°E (CAMS toàn cầu, độ phân giải ~45 km). ` +
    `Giờ địa phương (${s.timezone}). Chỉ số theo từng giờ được quy đổi trực tiếp từ nồng độ dự báo, không dùng Nowcast như trạm quan trắc.`;
}

function renderLegend() {
  $('legend').replaceChildren(
    ...LEVELS.map((l) => el('li', {}, el('i', { style: { background: l.display } }), l.label)),
    el('li', {}, el('i', { class: 'line' }), `Ngưỡng WHO 24 giờ (${WHO_PM25_24H} µg/m³)`),
  );
}

// ---------- Chế độ tổ chức ----------

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
  const today = todayStr();

  const head = el(
    'tr',
    {},
    el('th', { scope: 'col' }, 'Hoạt động'),
    ...days.map((d) => el('th', { scope: 'col' }, `${dayLabel(d, today)} ${shortDate(d)}`)),
  );
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
            el('span', { class: 'verdict__meta' }, `PM2.5 cao nhất ${num(v.peak)} µg/m³ · ${v.level.label}`),
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
  const today = todayStr();
  const now = s.times[s.nowIndex];
  const lines = [
    state.orgType === 'school' ? 'Kính gửi quý phụ huynh và các em học sinh,' : 'Gửi anh chị em làm việc ngoài trời,',
    '',
    `📢 LỊCH HOẠT ĐỘNG NGOÀI TRỜI THEO DỰ BÁO BỤI MỊN – ${s.source === 'sample' ? 'Hà Nội (dữ liệu mẫu)' : place().name}`,
    `(Cập nhật ${now.slice(11, 16)} ngày ${shortDate(datePart(now))})`,
  ];
  for (const d of days) {
    lines.push('', `${dayLabel(d, today)} ${shortDate(d)}:`);
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

async function copyNotice() {
  const text = $('notice').textContent;
  const status = $('copy-status');
  try {
    await navigator.clipboard.writeText(text);
    status.textContent = 'Đã sao chép ✓';
  } catch {
    const details = $('notice').closest('details');
    details.open = true;
    const range = document.createRange();
    range.selectNodeContents($('notice'));
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    status.textContent = 'Đã bôi đen nội dung, nhấn Ctrl+C để sao chép';
  }
  setTimeout(() => (status.textContent = ''), 4000);
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

  const hourOpts = (sel, from, to, current) =>
    sel.replaceChildren(
      ...Array.from({ length: to - from + 1 }, (_, k) => from + k).map((h) =>
        el('option', { value: h, selected: h === current }, formatClock(h)),
      ),
    );
  hourOpts($('from-hour'), 0, 23, state.fromHour);
  hourOpts($('to-hour'), 1, 24, state.toHour);
  $('from-hour').addEventListener('change', (e) => {
    state.fromHour = Number(e.target.value);
    if (state.toHour <= state.fromHour) {
      state.toHour = Math.min(24, state.fromHour + 1);
      $('to-hour').value = state.toHour;
    }
    renderAll();
  });
  $('to-hour').addEventListener('change', (e) => {
    state.toHour = Number(e.target.value);
    if (state.toHour <= state.fromHour) {
      state.fromHour = Math.max(0, state.toHour - 1);
      $('from-hour').value = state.fromHour;
    }
    renderAll();
  });
  $('planned').addEventListener('change', (e) => {
    state.planned = e.target.value === '' ? null : Number(e.target.value);
    renderPlanner();
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
  if (state.series) renderStation();
});
