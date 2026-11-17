import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hazeOpacity, mix, MOOD, skyAt } from '../src/scene.js';
import { LEVELS } from '../src/aqi.js';

test('lớp bụi mù đậm dần theo PM2.5 và có giới hạn', () => {
  assert.equal(hazeOpacity(null), 0);
  assert.equal(hazeOpacity(5), 0);
  const values = [8, 11, 23, 56, 150, 400].map(hazeOpacity);
  for (let i = 1; i < values.length; i++) assert.ok(values[i] > values[i - 1] || values[i] === 0.85, values);
  assert.equal(hazeOpacity(400), 0.85);
  // Hai giờ cùng mức Tốt (11 và 23 µg/m³) vẫn phải nhìn khác nhau
  assert.ok(hazeOpacity(23) - hazeOpacity(11) > 0.08);
});

test('màu trời theo giờ trong ngày', () => {
  assert.equal(skyAt(2).phase, 'night');
  assert.equal(skyAt(5).phase, 'dawn');
  assert.equal(skyAt(13).phase, 'day');
  assert.equal(skyAt(18).phase, 'dusk');
  assert.equal(skyAt(22).phase, 'night');
});

test('pha màu', () => {
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(mix('#3fa36b', '#0b1a33', 0), '#3fa36b');
});

test('mỗi mức chất lượng không khí đều có lời thoại', () => {
  for (const l of LEVELS) assert.ok(MOOD[l.id], l.id);
});
