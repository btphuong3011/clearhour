import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'acorn';
import { english, vietnamese } from '../src/messages.js';

const src = new URL('../src/', import.meta.url);
const ast = (file) => parse(readFileSync(new URL(file, src), 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' });

function visit(node, inspect) {
  if (!node || typeof node.type !== 'string') return;
  inspect(node);
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) child.forEach((item) => visit(item, inspect));
    else visit(child, inspect);
  }
}

const placeholders = (value) => [...new Set(
  Array.from(value.matchAll(/\{(\d+)\}/g), (match) => match[1]),
)].sort();

test('mỗi chuỗi tĩnh dùng qua t() hoặc thẻ t có bản tiếng Anh', () => {
  const missing = new Set();
  for (const file of readdirSync(src).filter((name) => name.endsWith('.js') && name !== 'messages.js')) {
    visit(ast(file), (node) => {
      const literal = node.type === 'CallExpression' && node.callee.name === 't' ? node.arguments[0] : null;
      const template = node.type === 'TaggedTemplateExpression' && node.tag.name === 't' ? node.quasi : null;
      const key = typeof literal?.value === 'string' ? literal.value : template?.quasis
        .map(({ value }, i) => (i ? '{' + (i - 1) + '}' : '') + value.cooked).join('');
      if (key != null && !Object.hasOwn(english, key)) missing.add(file + ': ' + key);
    });
  }
  assert.deepEqual([...missing], []);
});

test('mỗi danh mục giữ biến chèn và dùng khóa duy nhất; tiếng Việt có thể dùng chính khóa làm câu', () => {
  visit(ast('messages.js'), (node) => {
    if (node.type !== 'ObjectExpression') return;
    const keys = node.properties.map(({ key }) => key.value);
    assert.equal(new Set(keys).size, keys.length, 'Khóa dịch bị khai báo hai lần');
  });
  for (const [key, message] of Object.entries(english)) {
    assert.deepEqual(placeholders(message), placeholders(key), key);
  }
  for (const [key, message] of Object.entries(vietnamese)) {
    assert.ok(Object.hasOwn(english, key), key);
    assert.deepEqual(placeholders(message), placeholders(key), key);
  }
});
