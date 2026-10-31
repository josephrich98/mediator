'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { Store } = require('../src/store');

function tmp() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'todo-')), 'todos.json'); }

test('add assigns ids and persists', () => {
  const s = new Store(tmp());
  const a = s.add('buy milk');
  const b = s.add('walk dog');
  assert.equal(a.id, 1); assert.equal(b.id, 2);
  const s2 = new Store(s.file);
  assert.deepEqual(s2.list().map(t => t.text), ['buy milk', 'walk dog']);
});

test('add rejects empty text', () => {
  const s = new Store(tmp());
  assert.throws(() => s.add('   '), /required/);
});

test('complete and remove', () => {
  const s = new Store(tmp());
  s.add('a'); s.add('b');
  assert.equal(s.complete(1).done, true);
  s.remove(2);
  assert.equal(s.list().length, 1);
  assert.throws(() => s.remove(99), /no todo/);
});
