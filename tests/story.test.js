import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStory, storySlides } from '../src/story.js';
import { dayPeriod, friendlyClock } from '../src/time.js';

/** 3 ngày giả lập từ 00:00 ngày 2026-11-01, "bây giờ" là 20:00 hôm đó. */
function makeSeries(days) {
  const values = days.flat();
  const times = values.map((_, i) => `2026-11-${String(1 + Math.floor(i / 24)).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00`);
  return { times, pm25: values, nowIndex: 20 };
}
const flat = (v) => Array(24).fill(v);

test('giờ dễ đọc theo cách nói thường ngày', () => {
  assert.equal(friendlyClock(6), '6:00 sáng');
  assert.equal(friendlyClock(7.5), '7:30 sáng');
  assert.equal(friendlyClock(12), '12:00 trưa');
  assert.equal(friendlyClock(17), '5:00 chiều');
  assert.equal(friendlyClock(19), '7:00 tối');
  assert.equal(friendlyClock(22), '10:00 tối');
  assert.equal(friendlyClock(23), '11:00 đêm');
  assert.equal(friendlyClock(0), '12:00 đêm');
  assert.equal(friendlyClock(24), '12:00 đêm');
  assert.equal(dayPeriod(11), 'trưa');
});

test('câu chuyện khuyên dời giờ khi buổi chiều ít bụi hơn hẳn 6 giờ sáng', () => {
  const tomorrow = flat(30);
  tomorrow[5] = 58;
  tomorrow[6] = 60;
  tomorrow[17] = 22;
  const s = makeSeries([flat(30), tomorrow, flat(30)]);
  const story = buildStory(s);
  assert.equal(story.day, '2026-11-02');
  assert.equal(story.outcome, 'switch');
  assert.equal(story.top.start, 24 + 17);
  assert.equal(story.cmp.pct, 63);
  const slides = storySlides(s, story, { place: 'Hà Nội' });
  assert.equal(slides.length, 5);
  assert.match(slides[1].text, /mức «Kém»/);
  assert.equal(slides[2].hours.filter((x) => x.free).length, 6);
  assert.match(slides[3].text, /5:00 chiều.*63%/);
  assert.ok(slides[4].cta);
});

test('câu chuyện giữ giờ cũ khi 6 giờ sáng đã ít bụi nhất', () => {
  const tomorrow = flat(30);
  tomorrow[6] = 12;
  const s = makeSeries([flat(30), tomorrow, flat(30)]);
  const story = buildStory(s);
  assert.equal(story.outcome, 'keep');
  const slides = storySlides(s, story, { place: 'Hà Nội' });
  assert.match(slides[3].text, /ít bụi nhất/);
  assert.ok(slides[4].cta);
});

test('không có dữ liệu ngày mai thì không kể chuyện', () => {
  const s = makeSeries([flat(30)]);
  assert.equal(buildStory(s), null);
});
