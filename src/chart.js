import { t } from './i18n.js';
import { aqiFromConcentration, levelForAqi } from './aqi.js';
import { conditionFlags, describeOutdoorWindow, windowConditions } from './conditions.js';
import { el, int, num } from './format.js';
import { datePart, hourOf, shortDate, weekday } from './time.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MARGIN = { top: 26, right: 14, bottom: 44, left: 34 };
const HEIGHT = 280;
const MIN_SLOT = 12;
const FLAG_ROW = 13;

const WARNING_ROWS = [
  { id: 'rain', icon: '🌧️', label: t('Mưa') },
  { id: 'heat', icon: '🌡️', label: t('Nóng') },
  { id: 'uv', icon: '☀️', label: 'UV' },
  { id: 'o3', icon: 'O₃', label: 'O₃' },
  { id: 'pm25', icon: '◉', label: 'PM2.5' },
];

export function chartHourFlags(series, index, sensitive) {
  const aqi = aqiFromConcentration(series.pm25[index], 'pm2_5');
  if (aqi == null) return conditionFlags(windowConditions(series, index, 1));
  return describeOutdoorWindow(series, { start: index, hours: 1, aqi }, sensitive).flags;
}

function flagValue(series, index, id) {
  const weather = series.weather;
  switch (id) {
    case 'rain': return `${int(weather.rainProb[index])}%`;
    case 'heat': return `${num(weather.feels[index])} °C`;
    case 'uv': return num(weather.uv[index]);
    case 'o3': return `${num(series.o3[index])} µg/m³`;
    default: return null;
  }
}

function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

function niceScale(max) {
  const steps = [5, 10, 20, 25, 50, 100, 200];
  const step = steps.find((s) => max / s <= 5) ?? 250;
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  return { top, ticks };
}

/** Cột có góc bo 4px ở đầu dữ liệu, vuông ở đường gốc. */
function barPath(x, y, w, h) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/**
 * Vẽ biểu đồ cột PM2.5 theo giờ.
 * @param {HTMLElement} host  khung cuộn chứa SVG
 * @param {HTMLElement} detail   Thông tin của giờ đang chọn
 * @param {{series, start, end, windows, planned, selected, dayText, sensitive, showOriginal}} opts
 *   windows: [{start, hours, rank}] các khung đề xuất; planned: {start, hours} giờ người dùng định đi;
 *   dayText: (dateStr) => nhãn ngày dưới trục.
 */
export function renderChart(host, detail, {
  series, start, end, windows = [], planned = null, selected = null, dayText, sensitive = false, showOriginal = false,
}) {
  const dayLabelOf = dayText ?? ((d) => `${weekday(d)} ${shortDate(d)}`);
  const n = end - start;
  const width = Math.max(host.clientWidth, n * MIN_SLOT + MARGIN.left + MARGIN.right);
  const plotW = width - MARGIN.left - MARGIN.right;
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const slot = plotW / n;
  const values = series.pm25.slice(start, end);
  const original = showOriginal ? series.pm25Raw?.slice(start, end) ?? [] : [];
  const flagsByHour = values.map((_, index) => chartHourFlags(series, start + index, sensitive));
  const visibleFlags = new Set(flagsByHour.flat().map((flag) => flag.id));
  const rows = WARNING_ROWS.filter((row) => visibleFlags.has(row.id));
  const flagSpace = rows.length ? rows.length * FLAG_ROW + 5 : 0;
  const height = HEIGHT + flagSpace;
  const maxValue = Math.max(30, ...values.filter(Number.isFinite), ...original.filter(Number.isFinite));
  const { top, ticks } = niceScale(maxValue * 1.08);
  const x = (i) => MARGIN.left + (i - start) * slot;
  const y = (v) => MARGIN.top + plotH - (v / top) * plotH;

  const root = svg('svg', {
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': t`Biểu đồ nồng độ PM2.5 theo giờ, ${n} giờ, cao nhất ${num(Math.max(...values))} µg/m³`,
  });

  // Lưới ngang mảnh
  for (const t of ticks) {
    root.append(svg('line', { x1: MARGIN.left, x2: width - MARGIN.right, y1: y(t), y2: y(t), stroke: 'var(--grid)', 'stroke-width': 1 }));
    root.append(svg('text', { x: MARGIN.left - 6, y: y(t) + 4, 'text-anchor': 'end' }, t));
  }

  // Ranh giới ngày + nhãn ngày
  const hourStep = slot >= 22 ? 2 : slot >= 11 ? 3 : 6;
  for (let i = start; i < end; i++) {
    const t = series.times[i];
    const h = hourOf(t);
    if (h === 0 || i === start) {
      if (h === 0) {
        root.append(svg('line', { x1: x(i), x2: x(i), y1: MARGIN.top, y2: height - MARGIN.bottom + 30, stroke: 'var(--line)', 'stroke-width': 1 }));
      }
      const d = datePart(t);
      if (h === 0 || h < 18) {
        root.append(svg('text', { x: x(i) + 4, y: height - 6, class: 't-day' }, dayLabelOf(d)));
      }
    }
    if (h % hourStep === 0) {
      root.append(svg('text', { x: x(i) + slot / 2, y: height - MARGIN.bottom + 15, 'text-anchor': 'middle' }, `${String(h).padStart(2, '0')}h`));
    }
  }

  // Vùng nền các khung giờ được gợi ý
  for (const w of windows) {
    if (w.start < start || w.start >= end) continue;
    const wx = x(w.start);
    const ww = Math.min(Math.ceil(w.hours), end - w.start) * slot;
    root.append(svg('rect', {
      x: wx, y: MARGIN.top, width: ww, height: plotH, fill: 'var(--accent-wash)', rx: 4,
    }));
    // Trùng với giờ định đi thì dịch sang phải, nhường chỗ cho ký hiệu hình thoi
    const cx = wx + ww / 2 + (planned?.start === w.start ? 10 : 0);
    root.append(svg('circle', {
      cx, cy: MARGIN.top - 12, r: 8, fill: 'var(--accent)',
      stroke: w.selected ? 'var(--ink)' : null, 'stroke-width': w.selected ? 2 : null,
    }));
    root.append(svg('text', { x: cx, y: MARGIN.top - 8.5, 'text-anchor': 'middle', class: 't-rank' }, w.rank));
  }

  // Cột dữ liệu: rộng tối đa 24px, khe 2px giữa các cột
  const barW = Math.max(2, Math.min(24, slot - 2));
  const bars = [];
  for (let i = start; i < end; i++) {
    const v = series.pm25[i];
    if (v == null) {
      bars.push(null);
      continue;
    }
    const level = levelForAqi(aqiFromConcentration(v, 'pm2_5'));
    const by = y(v);
    const bar = svg('path', {
      d: barPath(x(i) + (slot - barW) / 2, by, barW, MARGIN.top + plotH - by),
      fill: level.display,
      class: 'bar',
      opacity: i < series.nowIndex ? 0.38 : 1,
    });
    bars.push(bar);
    root.append(bar);
  }

  // Giờ người dùng định đi: khung viền + hình thoi, khác hẳn ký hiệu tròn đánh số của khung đề xuất
  if (planned && planned.start >= start && planned.start < end) {
    const px = x(planned.start);
    const pw = Math.min(Math.ceil(planned.hours), end - planned.start) * slot;
    root.append(svg('rect', { x: px + 1, y: MARGIN.top, width: pw - 2, height: plotH, fill: 'none', stroke: 'var(--ink)', 'stroke-width': 1.5, rx: 4 }));
    const cx = px + pw / 2 - (windows.some((w) => w.start === planned.start) ? 10 : 0);
    const cy = MARGIN.top - 12;
    root.append(svg('path', { d: `M${cx},${cy - 8}L${cx + 8},${cy}L${cx},${cy + 8}L${cx - 8},${cy}Z`, fill: 'var(--ink)' }));
  }

  if (selected && selected.start !== planned?.start && selected.start >= start && selected.start < end) {
    const sx = x(selected.start);
    const sw = Math.min(Math.ceil(selected.hours), end - selected.start) * slot;
    root.append(svg('rect', {
      x: sx + 1, y: MARGIN.top, width: sw - 2, height: plotH, fill: 'none',
      stroke: 'var(--accent)', 'stroke-width': 2.5, rx: 4,
      'aria-label': t('Khung đã chọn'),
    }));
  }

  // Mốc "bây giờ"
  if (series.nowIndex >= start && series.nowIndex < end) {
    const nx = x(series.nowIndex);
    root.append(svg('line', { x1: nx, x2: nx, y1: MARGIN.top - 2, y2: MARGIN.top + plotH, stroke: 'var(--accent)', 'stroke-width': 2 }));
    const roomLeft = nx - MARGIN.left > 56;
    root.append(svg('text', { x: nx + (roomLeft ? -5 : 5), y: MARGIN.top + 10, 'text-anchor': roomLeft ? 'end' : 'start', class: 't-now' }, t('Bây giờ')));
  }

  if (original.some(Number.isFinite)) {
    let previous = false;
    const path = original.map((value, k) => {
      const valid = Number.isFinite(value);
      const point = valid ? `${previous ? 'L' : 'M'}${x(start + k) + slot / 2},${y(value)}` : '';
      previous = valid;
      return point;
    }).join(' ');
    root.append(svg('path', { d: path, class: 'chart-original', 'aria-hidden': 'true' }));
  }

  // Mỗi hàng dành cho một loại cảnh báo. Tam giác chỉ giờ nên tránh, chấm tròn là lưu ý.
  rows.forEach((row, lane) => {
    const cy = HEIGHT - MARGIN.bottom + 8 + lane * FLAG_ROW;
    root.append(svg('text', { x: MARGIN.left - 7, y: cy + 3, 'text-anchor': 'end', class: 'chart-flag-label' }, row.icon));
    flagsByHour.forEach((flags, k) => {
      const flag = flags.find((entry) => entry.id === row.id);
      if (!flag) return;
      const cx = x(start + k) + slot / 2;
      const attrs = { class: `chart-flag chart-flag--${flag.severity}`, 'aria-hidden': 'true' };
      root.append(flag.severity === 'avoid'
        ? svg('path', { ...attrs, d: `M${cx},${cy - 4} L${cx + 4.5},${cy + 4} L${cx - 4.5},${cy + 4} Z` })
        : svg('circle', { ...attrs, cx, cy, r: 3 }));
    });
  });

  // Vùng chạm cao bằng cột và dải cảnh báo. Tab một lần, dùng phím mũi tên để đi qua các giờ.
  const hits = svg('g', { fill: 'transparent' });
  const selection = svg('rect', { y: MARGIN.top, width: slot, height: plotH + flagSpace, class: 'chart-hour-focus' });
  root.append(selection);
  let active = null;
  const inspect = (index, reveal = false) => {
    if (index !== active) {
      bars[active - start]?.classList.remove('is-hover');
      bars[index - start]?.classList.add('is-hover');
      active = index;
      const time = series.times[index];
      host.dataset.hour = time;
      selection.setAttribute('x', x(index));
      const value = series.pm25[index];
      const raw = original[index - start];
      const flags = flagsByHour[index - start];
      detail.replaceChildren(...[
        el('div', { class: 'chart-hour__main' },
          el('strong', {}, `${weekday(datePart(time))} ${shortDate(datePart(time))} · ${time.slice(11, 16)}`),
          el('span', {}, value == null ? t('PM2.5 chưa có dữ liệu') : `PM2.5 ${num(value)} µg/m³`),
          Number.isFinite(raw) ? el('span', { class: 'muted' }, t`CAMS gốc ${num(raw)} µg/m³`) : null,
        ),
        flags.length ? el('ul', { class: 'chart-hour__flags' }, ...flags.map((flag) => {
          const metric = flagValue(series, index, flag.id);
          return el('li', { class: `chart-hour__flag--${flag.severity}` },
            el('span', { 'aria-hidden': 'true' }, flag.icon),
            el('strong', {}, flag.label),
            metric ? el('span', {}, metric) : null,
            el('span', { class: 'muted' }, flag.severity === 'avoid' ? t('Nên tránh') : t('Lưu ý')),
          );
        })) : null,
      ].filter(Boolean));
    }
    if (reveal) {
      const left = x(index);
      if (left < host.scrollLeft) host.scrollLeft = left;
      else if (left + slot > host.scrollLeft + host.clientWidth) host.scrollLeft = left + slot - host.clientWidth;
    }
  };
  for (let index = start; index < end; index++) {
    const hit = svg('rect', { x: x(index), y: MARGIN.top - 20, width: slot, height: plotH + flagSpace + 20, 'data-hour': series.times[index] });
    hit.addEventListener('pointerenter', (event) => { if (event.pointerType === 'mouse') inspect(index); });
    hit.addEventListener('click', () => inspect(index));
    hits.append(hit);
  }
  root.append(hits);

  const remembered = series.times.indexOf(host.dataset.hour);
  const initial = remembered >= start && remembered < end ? remembered : selected?.start ?? planned?.start ?? series.nowIndex;
  host.replaceChildren(root);
  inspect(Math.max(start, Math.min(end - 1, initial)));
  host.onkeydown = (event) => {
    const next = { ArrowLeft: active - 1, ArrowRight: active + 1, Home: start, End: end - 1 }[event.key];
    if (next == null) return;
    event.preventDefault();
    inspect(Math.max(start, Math.min(end - 1, next)), true);
  };
  return rows;
}
