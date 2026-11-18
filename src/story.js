import { t } from './i18n.js';
// Câu chuyện "Một buổi sáng của Minh": kể lại cách dùng ClearHour bằng dự báo thật của ngày mai.
// Kết thúc thay đổi theo dữ liệu: có hôm nên dời giờ, có hôm cứ giữ giờ cũ.

import { LEVELS, levelForAqi, levelForPm25 } from './aqi.js';
import { compareWithPlan, findBestWindows, windowStats } from './planner.js';
import { MOOD, renderScene } from './scene.js';
import { addDays, datePart, friendlyClock, hourOf } from './time.js';

export const STORY_PLAN_HOUR = 6;
export const STORY_FREE = [
  { from: 5, to: 7 },
  { from: 17, to: 21 },
];

// Tả bầu trời bằng lời theo mức chất lượng không khí
const SKY_WORDS = {
  good: t('trời khá trong'),
  moderate: t('trời hơi đục'),
  poor: t('trời mù bụi'),
  unhealthy: t('bụi dày, nhìn xa đã thấy mờ'),
  'very-unhealthy': t('bụi rất dày'),
  hazardous: t('bụi ở mức nguy hại'),
};

/** Diễn biến câu chuyện: giờ quen của Minh, lúc ít bụi nhất trong giờ rảnh, nên dời hay giữ. */
export function buildStory(series) {
  const today = datePart(series.times[series.nowIndex]);
  const day = addDays(today, 1);
  const planStart = series.times.indexOf(`${day}T${String(STORY_PLAN_HOUR).padStart(2, '0')}:00`);
  if (planStart < 0) return null;
  const plan = windowStats(series.pm25, planStart, 1);
  if (!plan) return null;
  const { best } = findBestWindows(series, { scope: 'tomorrow', ranges: STORY_FREE, hours: 1 }, 3);
  const top = best.find((w) => w.start !== planStart) ?? null;
  const cmp = top ? compareWithPlan(plan, top) : null;
  return { day, plan, top, cmp, outcome: cmp?.relation === 'better' ? 'switch' : 'keep' };
}

/** Lời kể và cảnh minh họa cho từng bước. */
export function storySlides(series, story, { place }) {
  const planLevel = levelForAqi(story.plan.aqi);
  const planTime = friendlyClock(STORY_PLAN_HOUR);
  const plan = { hour: STORY_PLAN_HOUR, pm25: story.plan.mean };
  const slides = [
    { art: 'scene', ...plan, text: t`Sáng mai, Minh định chạy bộ quanh hồ lúc ${planTime} như mọi khi.` },
    {
      art: 'scene',
      ...plan,
      bubble: MOOD[planLevel.id],
      text: t`Dự báo cho ${place}: lúc ${planTime} không khí ở mức «${planLevel.label}», ${SKY_WORDS[planLevel.id]}.`,
    },
    {
      art: 'strip',
      hours: series.times
        .map((t, i) => ({ t, i }))
        .filter(({ t }) => datePart(t) === story.day)
        .map(({ t, i }) => ({ hour: hourOf(t), level: levelForPm25(series.pm25[i]), free: STORY_FREE.some((r) => hourOf(t) >= r.from && hourOf(t) < r.to) })),
      text: t('Minh mở ClearHour và chọn những lúc mình rảnh: 5–7 giờ sáng và 5–9 giờ tối.'),
    },
  ];

  if (story.outcome === 'switch') {
    const topHour = hourOf(series.times[story.top.start]);
    const topLevel = levelForAqi(story.top.aqi);
    slides.push(
      {
        art: 'compare',
        from: plan,
        to: { hour: topHour, pm25: story.top.mean },
        labels: [planTime, friendlyClock(topHour)],
        text: t`ClearHour gợi ý dời sang ${friendlyClock(topHour)}: bụi mịn dự báo ít hơn khoảng ${story.cmp.pct}%.`,
      },
      {
        art: 'scene',
        hour: topHour,
        pm25: story.top.mean,
        bubble: topLevel.id === 'good' ? t('Hẹn cả nhóm nhé!') : MOOD[topLevel.id],
        text: t`Minh thêm ${friendlyClock(topHour)} vào lịch và rủ cả nhóm chạy cùng. Còn bạn, định ra ngoài lúc nào?`,
        cta: true,
      },
    );
  } else {
    slides.push(
      {
        art: 'scene',
        ...plan,
        bubble: t('Giữ giờ cũ thôi!'),
        text: story.top
          ? t`Hóa ra ${planTime} đã gần như là lúc ít bụi nhất trong những giờ Minh rảnh. Đổi giờ cũng không đỡ được bao nhiêu.`
          : t`Trong những giờ Minh rảnh, không có lúc nào ít bụi hơn ${planTime}.`,
      },
      {
        art: 'scene',
        ...plan,
        bubble: LEVELS.indexOf(planLevel) >= 3 ? MOOD[planLevel.id] : t('Đi thôi!'),
        text: t('Minh cứ đi như thường, yên tâm vì đã kiểm tra trước. Còn bạn, định ra ngoài lúc nào?'),
        cta: true,
      },
    );
  }
  return slides;
}

// ---------- Hiển thị ----------

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') Object.assign(node.style, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

function artFor(slide, figure, k) {
  if (slide.art === 'strip') {
    return h(
      'div',
      { class: 'story__phone' },
      h('p', { class: 'story__phone-title' }, t('ClearHour · Ngày mai')),
      h(
        'div',
        { class: 'story__strip', role: 'img', 'aria-label': t('Mức bụi từng giờ ngày mai, các giờ Minh rảnh được làm nổi bật') },
        ...slide.hours.map((x) => h('span', { class: x.free ? 'is-free' : null, style: { background: x.level?.display ?? '#ccc' } })),
      ),
      h('div', { class: 'story__strip-axis' }, h('span', {}, '0h'), h('span', {}, '6h'), h('span', {}, '12h'), h('span', {}, '18h'), h('span', {}, '23h')),
      h('p', { class: 'story__phone-note' }, t('Ô đậm là giờ Minh rảnh')),
    );
  }
  if (slide.art === 'compare') {
    const side = (s, label, cls) => {
      const box = h('figure', { class: `story__side ${cls}` });
      box.append(
        renderScene({ width: 600, height: 360, hour: s.hour, pm25: s.pm25, figure, figureX: 0.5, figureScale: 0.2, seed: 11, id: `st${k}${cls}`, label }),
        h('figcaption', {}, label),
      );
      return box;
    };
    return h('div', { class: 'story__compare' }, side(slide.from, slide.labels[0], 'from'), h('span', { class: 'story__arrow', 'aria-hidden': 'true' }, '→'), side(slide.to, slide.labels[1], 'to'));
  }
  const wrap = h('div', { class: 'story__scene' });
  wrap.append(
    renderScene({
      width: 1200,
      height: 520,
      hour: slide.hour,
      pm25: slide.pm25,
      figure,
      bubble: slide.bubble,
      figureX: 0.5,
      figureScale: 0.16,
      seed: 11,
      id: `st${k}`,
      label: slide.text,
    }),
  );
  return wrap;
}

/**
 * Mở câu chuyện toàn màn hình.
 * opts: { series, place, sample, figure, onFinish }
 */
export function openStory({ series, place, sample, figure = '🏃', onFinish }) {
  const story = buildStory(series);
  if (!story) return;
  const slides = storySlides(series, story, { place });
  const opener = document.activeElement;
  let k = 0;

  const art = h('div', { class: 'story__art' });
  const step = h('p', { class: 'story__step' });
  const text = h('h2', { class: 'story__text', id: 'story-text', 'aria-live': 'polite' });
  const back = h('button', { type: 'button', class: 'btn btn--ghost', onclick: () => go(k - 1) }, t('← Quay lại'));
  const next = h('button', { type: 'button', class: 'btn' });
  const dots = h('div', { class: 'story__dots', 'aria-hidden': 'true' }, ...slides.map(() => h('span')));
  const note = h(
    'p',
    { class: 'story__note' },
    sample
      ? t('Câu chuyện đang dùng dữ liệu mẫu của Hà Nội.')
      : t`Câu chuyện dùng dự báo thật của ${place} cho ngày mai, nên mỗi ngày một khác.`,
  );
  const close = () => {
    document.removeEventListener('keydown', onKey);
    dialog.remove();
    document.body.classList.remove('has-story');
    opener?.focus?.();
  };
  const finish = () => {
    close();
    onFinish?.();
  };
  const dialog = h(
    'div',
    { class: 'story', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'story-text', onclick: (e) => e.target === dialog && close() },
    h(
      'div',
      { class: 'story__panel' },
      h('button', { type: 'button', class: 'story__close', 'aria-label': t('Đóng câu chuyện'), onclick: close }, '✕'),
      art,
      h('div', { class: 'story__body' }, step, text, h('div', { class: 'story__nav' }, back, dots, next), note),
    ),
  );

  function go(n) {
    if (n < 0 || n >= slides.length) return;
    k = n;
    const s = slides[k];
    art.replaceChildren(artFor(s, figure, k));
    step.textContent = t`Minh và buổi chạy sáng mai · ${k + 1}/${slides.length}`;
    text.textContent = s.text;
    back.disabled = k === 0;
    next.textContent = s.cta ? t('Thử với lịch của bạn') : t('Tiếp →');
    next.onclick = s.cta ? finish : () => go(k + 1);
    [...dots.children].forEach((d, i) => d.classList.toggle('is-on', i === k));
    next.focus();
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight') go(k + 1);
    else if (e.key === 'ArrowLeft') go(k - 1);
    else if (e.key === 'Tab') {
      const buttons = [...dialog.querySelectorAll('button:not(:disabled)')];
      const first = buttons[0];
      const last = buttons.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  document.body.append(dialog);
  document.body.classList.add('has-story');
  document.addEventListener('keydown', onKey);
  go(0);
}
