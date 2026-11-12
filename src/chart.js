import { aqiFromConcentration, levelForAqi } from './aqi.js';
import { num } from './format.js';
import { datePart, hourOf, shortDate, weekday } from './time.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MARGIN = { top: 26, right: 14, bottom: 44, left: 34 };
const HEIGHT = 280;
const MIN_SLOT = 8;

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
 * @param {HTMLElement} tip   tooltip dùng chung
 * @param {{series, start, end, windows, planned, dayText}} opts
 *   windows: [{start, hours, rank}] các khung đề xuất; planned: {start, hours} giờ người dùng định đi;
 *   dayText: (dateStr) => nhãn ngày dưới trục.
 */
export function renderChart(host, tip, { series, start, end, windows = [], planned = null, dayText }) {
  const dayLabelOf = dayText ?? ((d) => `${weekday(d)} ${shortDate(d)}`);
  const n = end - start;
  const width = Math.max(host.clientWidth, n * MIN_SLOT + MARGIN.left + MARGIN.right);
  const plotW = width - MARGIN.left - MARGIN.right;
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const slot = plotW / n;
  const values = series.pm25.slice(start, end);
  const { top, ticks } = niceScale(Math.max(30, ...values.filter((v) => v != null)) * 1.08);
  const x = (i) => MARGIN.left + (i - start) * slot;
  const y = (v) => MARGIN.top + plotH - (v / top) * plotH;

  const root = svg('svg', {
    width,
    height: HEIGHT,
    viewBox: `0 0 ${width} ${HEIGHT}`,
    role: 'img',
    'aria-label': `Biểu đồ nồng độ PM2.5 theo giờ, ${n} giờ, cao nhất ${num(Math.max(...values))} µg/m³`,
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
        root.append(svg('line', { x1: x(i), x2: x(i), y1: MARGIN.top, y2: HEIGHT - MARGIN.bottom + 30, stroke: 'var(--line)', 'stroke-width': 1 }));
      }
      const d = datePart(t);
      if (h === 0 || h < 18) {
        root.append(svg('text', { x: x(i) + 4, y: HEIGHT - 6, class: 't-day' }, dayLabelOf(d)));
      }
    }
    if (h % hourStep === 0) {
      root.append(svg('text', { x: x(i) + slot / 2, y: HEIGHT - MARGIN.bottom + 15, 'text-anchor': 'middle' }, `${String(h).padStart(2, '0')}h`));
    }
  }

  // Vùng nền các khung giờ được gợi ý
  for (const w of windows) {
    if (w.start < start || w.start >= end) continue;
    const wx = x(w.start);
    const ww = Math.min(Math.ceil(w.hours), end - w.start) * slot;
    root.append(svg('rect', { x: wx, y: MARGIN.top, width: ww, height: plotH, fill: 'var(--accent-wash)', rx: 4 }));
    // Trùng với giờ định đi thì dịch sang phải, nhường chỗ cho ký hiệu hình thoi
    const cx = wx + ww / 2 + (planned?.start === w.start ? 10 : 0);
    root.append(svg('circle', { cx, cy: MARGIN.top - 12, r: 8, fill: 'var(--accent)' }));
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

  // Mốc "bây giờ"
  if (series.nowIndex >= start && series.nowIndex < end) {
    const nx = x(series.nowIndex);
    root.append(svg('line', { x1: nx, x2: nx, y1: MARGIN.top - 2, y2: MARGIN.top + plotH, stroke: 'var(--accent)', 'stroke-width': 2 }));
    const roomLeft = nx - MARGIN.left > 56;
    root.append(svg('text', { x: nx + (roomLeft ? -5 : 5), y: MARGIN.top + 10, 'text-anchor': roomLeft ? 'end' : 'start', class: 't-now' }, 'Bây giờ'));
  }

  // Lớp bắt chuột: mỗi giờ là một vùng cao bằng cả biểu đồ
  const hits = svg('g', { fill: 'transparent' });
  let hovered = null;
  const hide = () => {
    tip.hidden = true;
    hovered?.classList.remove('is-hover');
    hovered = null;
  };
  for (let i = start; i < end; i++) {
    const v = series.pm25[i];
    if (v == null) continue;
    const hit = svg('rect', { x: x(i), y: MARGIN.top - 20, width: slot, height: plotH + 20 });
    const show = (ev) => {
      hovered?.classList.remove('is-hover');
      hovered = bars[i - start];
      hovered?.classList.add('is-hover');
      const aqi = aqiFromConcentration(v, 'pm2_5');
      const level = levelForAqi(aqi);
      const t = series.times[i];
      tip.replaceChildren();
      const head = document.createElement('div');
      head.className = 'muted';
      head.textContent = `${weekday(datePart(t))} ${shortDate(datePart(t))} · ${t.slice(11, 16)}${i < series.nowIndex ? ' (đã qua)' : ''}`;
      const val = document.createElement('div');
      const strong = document.createElement('strong');
      strong.textContent = num(v);
      val.append(strong, ' µg/m³ PM2.5');
      const lv = document.createElement('div');
      const key = document.createElement('span');
      key.className = 'key';
      key.style.background = level.display;
      lv.append(key, `VN_AQI ≈ ${aqi} · ${level.label}`);
      tip.append(head, val, lv);
      tip.hidden = false;
      const box = host.parentElement.getBoundingClientRect();
      const px = (ev.clientX ?? box.left + x(i) - host.scrollLeft) - box.left;
      const tw = tip.offsetWidth;
      tip.style.left = `${Math.min(Math.max(px - tw / 2, 0), box.width - tw)}px`;
      tip.style.top = `${Math.max(0, y(v) - 78)}px`;
    };
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('pointermove', show);
    hit.addEventListener('pointerdown', show);
    hits.append(hit);
  }
  root.addEventListener('pointerleave', hide);
  root.append(hits);

  host.replaceChildren(root);
  host.onscroll = hide;
}
