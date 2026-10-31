'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { formatItem, formatList, formatSummary } = require('../src/format');

test('formatItem shows checkbox, id and text', () => {
  assert.equal(formatItem({ id: 7, text: 'hi', done: false }), '[ ]   7  hi');
  assert.equal(formatItem({ id: 12, text: 'yo', done: true }), '[x]  12  yo');
});

test('formatList handles empty', () => {
  assert.equal(formatList([]), '(no todos)');
});

test('formatSummary counts', () => {
  assert.equal(formatSummary([{ done: true }, { done: false }]), '2 todos, 1 done');
});
