'use strict';

function formatItem(item) {
  const box = item.done ? '[x]' : '[ ]';
  return `${box} ${String(item.id).padStart(3)}  ${item.text}`;
}

function formatList(items) {
  if (!items.length) return '(no todos)';
  return items.map(formatItem).join('\n');
}

function formatSummary(items) {
  const done = items.filter(i => i.done).length;
  return `${items.length} todo${items.length === 1 ? '' : 's'}, ${done} done`;
}

module.exports = { formatItem, formatList, formatSummary };
