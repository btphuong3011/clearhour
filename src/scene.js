import { t } from './i18n.js';
// Cảnh thành phố vẽ bằng SVG: màu trời theo giờ trong ngày, lớp bụi mù đậm nhạt theo nồng độ PM2.5 dự báo.
// Nhà phố, cao ốc, cây và đường được sinh ngẫu nhiên có hạt giống nên lần nào vẽ cũng giống nhau.

const NS = 'http://www.w3.org/2000/svg';

// [giờ bắt đầu, màu trời phía trên, màu trời sát chân trời, pha]
const SKY = [
  [0, '#0b1a33', '#1d3358', 'night'],
  [5, '#34437c', '#f2a07e', 'dawn'],
  [6, '#5b8fd9', '#ffd2a6', 'dawn'],
  [7, '#3f9bf0', '#d4eeff', 'day'],
  [16, '#5596e6', '#ffe1bc', 'day'],
  [17, '#5768bb', '#ffb385', 'dusk'],
  [18, '#2d3c78', '#e57d66', 'dusk'],
  [19, '#0b1a33', '#1d3358', 'night'],
];

const HAZE = { day: '#c9bca8', dawn: '#d6b199', dusk: '#cfa58f', night: '#5f5f6d' };
const DARKEN = { day: 0, dawn: 0.22, dusk: 0.28, night: 0.62 };
const NIGHT_INK = '#0b1a33';

const FACADES = ['#f6c28b', '#9fd3c7', '#f4a9a0', '#c7b8ea', '#ffe08a', '#a8d5f2', '#f7d6b3'];
const TOWER = '#6fa8cc';
const FAR = '#a9bccf';

/** Độ đậm của lớp bụi mù (0–0,85). Đường cong căn bậc để mức bụi thấp vẫn phân biệt được bằng mắt. */
export function hazeOpacity(pm25) {
  if (pm25 == null || Number.isNaN(pm25)) return 0;
  const x = Math.min(1, Math.max(0, (pm25 - 5) / 145));
  return Math.round(x ** 0.6 * 0.85 * 1000) / 1000;
}

export function skyAt(hour) {
  let row = SKY[0];
  for (const r of SKY) if (hour >= r[0]) row = r;
  return { top: row[1], bottom: row[2], phase: row[3] };
}

/** Lời nhân vật trong cảnh theo mức chất lượng không khí. */
export const MOOD = {
  good: t('Trời trong, ra ngoài thôi!'),
  moderate: t('Không khí tạm ổn'),
  poor: t('Hơi bụi, đi nhẹ thôi'),
  unhealthy: t('Bụi nhiều, nhớ khẩu trang!'),
  'very-unhealthy': t('Ở trong nhà thì hơn'),
  hazardous: t('Đóng cửa, ở trong nhà!'),
};

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pha màu `a` với `b` theo tỉ lệ t (0–1). */
export function mix(a, b, t) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}

const layoutCache = new Map();

/** Bố cục thành phố: chỉ phụ thuộc kích thước và hạt giống, tính một lần rồi dùng lại. */
function cityLayout(W, H, seed) {
  const key = `${W}x${H}:${seed}`;
  if (layoutCache.has(key)) return layoutCache.get(key);
  const r = rng(seed);
  const ground = H - Math.round(H * 0.12);
  const far = [];
  for (let x = -20; x < W; ) {
    const w = 40 + r() * 60;
    far.push({ x, w, h: H * (0.22 + r() * 0.3) });
    x += w - 6;
  }
  const near = [];
  const towerSlots = new Set([Math.floor(W / 200), Math.floor(W / 95), Math.floor(W / 60)]);
  let n = 0;
  for (let x = -10; x < W; n++) {
    const tower = towerSlots.has(n);
    const w = tower ? 70 + r() * 30 : 32 + r() * 26;
    const h = tower ? H * (0.48 + r() * 0.16) : H * (0.2 + r() * 0.2);
    const windows = [];
    if (tower) {
      for (let wy = ground - h + 12; wy < ground - 14; wy += 18) {
        for (let wx = x + 8; wx < x + w - 10; wx += 14) windows.push({ x: wx, y: wy, w: 7, h: 9, lit: r() < 0.35 });
      }
    } else {
      for (let wy = ground - h + 12; wy < ground - 20; wy += 24) {
        const cols = w > 44 ? 2 : 1;
        for (let c = 0; c < cols; c++) {
          windows.push({ x: x + (cols === 1 ? w / 2 - 5 : 7 + c * (w - 24)), y: wy, w: 10, h: 12, lit: r() < 0.5 });
        }
      }
    }
    near.push({ x, w, h, tower, color: tower ? TOWER : FACADES[Math.floor(r() * FACADES.length)], windows, balcony: !tower && r() < 0.6 });
    x += w + (r() < 0.25 ? 6 : 0);
  }
  const trees = [];
  for (let x = 30 + r() * 40; x < W; x += 90 + r() * 90) trees.push({ x, s: 0.8 + r() * 0.5 });
  const stars = Array.from({ length: 22 }, () => ({ x: r() * W, y: r() * H * 0.45, s: 0.6 + r() * 1.1 }));
  const layout = { ground, far, near, trees, stars };
  layoutCache.set(key, layout);
  return layout;
}

function node(tag, attrs = {}, text) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}

/**
 * Vẽ một cảnh. hour: giờ trong ngày (0–23); pm25: nồng độ dự báo; figure: emoji nhân vật; bubble: lời thoại.
 * Trả về phần tử <svg> co giãn theo khung chứa (cắt hai bên, giữ chân cảnh).
 */
export function renderScene({ width = 1200, height = 360, hour, pm25, figure, bubble, figureX = 0.62, figureScale = 0.15, seed = 11, label, id = 's' }) {
  const W = width;
  const H = height;
  const sky = skyAt(hour);
  const haze = hazeOpacity(pm25);
  const dark = DARKEN[sky.phase];
  const { ground, far, near, trees, stars } = cityLayout(W, H, seed);

  const svg = node('svg', {
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: 'xMidYMax slice',
    role: 'img',
    'aria-label': label,
    class: 'scene',
  });
  const defs = node('defs');
  const skyGrad = node('linearGradient', { id: `${id}-sky`, x1: 0, y1: 0, x2: 0, y2: 1 });
  skyGrad.append(node('stop', { offset: 0, 'stop-color': sky.top }), node('stop', { offset: 1, 'stop-color': sky.bottom }));
  const hazeGrad = node('linearGradient', { id: `${id}-haze`, x1: 0, y1: 0, x2: 0, y2: 1 });
  hazeGrad.append(
    node('stop', { offset: 0, 'stop-color': HAZE[sky.phase], 'stop-opacity': haze * 0.55 }),
    node('stop', { offset: 1, 'stop-color': HAZE[sky.phase], 'stop-opacity': haze }),
  );
  const glow = node('radialGradient', { id: `${id}-glow` });
  glow.append(node('stop', { offset: 0, 'stop-color': '#fff6c7', 'stop-opacity': 0.9 }), node('stop', { offset: 1, 'stop-color': '#fff6c7', 'stop-opacity': 0 }));
  defs.append(skyGrad, hazeGrad, glow);
  svg.append(defs, node('rect', { width: W, height: H, fill: `url(#${id}-sky)` }));

  // Mặt trời đi theo cung từ 6h đến 18h; ban đêm là trăng và sao
  if (hour >= 6 && hour <= 18) {
    const t = (hour - 6) / 12;
    const cx = W * (0.08 + 0.84 * t);
    const cy = ground - Math.sin(Math.PI * t) * H * 0.62;
    svg.append(node('circle', { cx, cy, r: H * 0.16, fill: `url(#${id}-glow)` }), node('circle', { cx, cy, r: H * 0.055, fill: '#ffd25e' }));
  } else {
    for (const st of stars) svg.append(node('circle', { cx: st.x, cy: st.y, r: st.s, fill: '#ffffff', opacity: Math.max(0, 0.85 - haze * 1.2) }));
    const mx = W * 0.82;
    const my = H * 0.2;
    svg.append(node('circle', { cx: mx, cy: my, r: H * 0.05, fill: '#f4f1de' }), node('circle', { cx: mx + H * 0.022, cy: my - H * 0.012, r: H * 0.045, fill: sky.top }));
  }

  // Dãy nhà xa, rồi lớp bụi mù (đậm nhất ở xa)
  const farColor = mix(FAR, NIGHT_INK, dark * 0.8);
  for (const b of far) svg.append(node('rect', { x: b.x, y: ground - b.h, width: b.w, height: b.h, fill: farColor }));
  svg.append(node('rect', { width: W, height: H, fill: `url(#${id}-haze)` }));

  // Dãy nhà gần: nhà ống nhiều màu và vài cao ốc
  for (const b of near) {
    const top = ground - b.h;
    svg.append(node('rect', { x: b.x, y: top, width: b.w, height: b.h, fill: mix(b.color, NIGHT_INK, dark) }));
    if (!b.tower) svg.append(node('rect', { x: b.x - 2, y: top - 4, width: b.w + 4, height: 5, fill: mix('#8a6f5a', NIGHT_INK, dark) }));
    if (b.balcony) svg.append(node('rect', { x: b.x + 3, y: top + b.h * 0.42, width: b.w - 6, height: 3, fill: mix('#6b5b4d', NIGHT_INK, dark) }));
    for (const w of b.windows) {
      const lit = dark > 0.2 && w.lit;
      svg.append(
        node('rect', {
          x: w.x,
          y: w.y,
          width: w.w,
          height: w.h,
          rx: 1.5,
          fill: lit ? '#ffd36b' : mix(b.tower ? '#d9eefb' : '#fdfaf3', NIGHT_INK, dark * 0.9),
          opacity: lit ? 0.95 : 0.8,
        }),
      );
    }
  }

  // Cây và mặt đường
  const leaf = mix('#3fa36b', NIGHT_INK, dark * 0.8);
  const leafDark = mix('#2c7a50', NIGHT_INK, dark * 0.8);
  for (const t of trees) {
    svg.append(
      node('rect', { x: t.x - 2.5 * t.s, y: ground - 16 * t.s, width: 5 * t.s, height: 16 * t.s, fill: mix('#7a5a3c', NIGHT_INK, dark) }),
      node('circle', { cx: t.x, cy: ground - 24 * t.s, r: 13 * t.s, fill: leaf }),
      node('circle', { cx: t.x + 7 * t.s, cy: ground - 18 * t.s, r: 9 * t.s, fill: leafDark }),
    );
  }
  svg.append(
    node('rect', { x: 0, y: ground, width: W, height: H - ground, fill: mix('#56606e', NIGHT_INK, dark * 0.6) }),
    node('rect', { x: 0, y: ground, width: W, height: 4, fill: mix('#c9ced6', NIGHT_INK, dark * 0.6) }),
  );
  const laneY = ground + (H - ground) * 0.6;
  for (let x = 10; x < W; x += 48) svg.append(node('rect', { x, y: laneY, width: 24, height: 3, rx: 1.5, fill: '#f4f4f4', opacity: 0.7 }));

  // Lớp bụi phía trước, nhạt hơn
  svg.append(node('rect', { width: W, height: H, fill: HAZE[sky.phase], opacity: haze * 0.45 }));

  // Nhân vật và lời thoại
  if (figure) {
    const fx = W * figureX;
    const size = Math.round(H * figureScale);
    svg.append(node('text', { x: fx, y: ground + size * 0.3, 'font-size': size, 'text-anchor': 'middle', class: 'scene__figure' }, figure));
    if (bubble) {
      const fs = Math.max(12, Math.round(H * 0.05));
      const bw = bubble.length * fs * 0.52 + fs * 1.4;
      const bh = fs * 2;
      const bx = Math.min(W - bw - 8, Math.max(8, fx - bw / 2));
      const by = ground - size - bh - 6;
      svg.append(
        node('rect', { x: bx, y: by, width: bw, height: bh, rx: bh / 2, fill: '#ffffff', opacity: 0.95 }),
        node('path', { d: `M${fx - 6},${by + bh - 1}L${fx},${by + bh + 8}L${fx + 6},${by + bh - 1}Z`, fill: '#ffffff', opacity: 0.95 }),
        node('text', { x: bx + bw / 2, y: by + bh * 0.66, 'font-size': fs, 'text-anchor': 'middle', class: 'scene__bubble' }, bubble),
      );
    }
  }
  return svg;
}
