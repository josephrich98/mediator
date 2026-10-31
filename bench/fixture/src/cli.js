#!/usr/bin/env node
'use strict';
const path = require('path');
const { Store } = require('./store');
const { formatList, formatSummary, formatItem } = require('./format');

const USAGE = `usage:
  todo add <text>        add a todo
  todo list              list todos
  todo done <id>         mark a todo complete
  todo rm <id>           remove a todo
Options:
  --file <path>          todo file (default: ./todos.json or $TODO_FILE)`;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      opts[key] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  const file = opts.file || process.env.TODO_FILE || path.join(process.cwd(), 'todos.json');
  const store = new Store(file);
  const [cmd, ...rest] = opts._;
  switch (cmd) {
    case 'add': {
      const item = store.add(rest.join(' '));
      return `added ${formatItem(item)}`;
    }
    case 'list':
      return formatList(store.list()) + '\n' + formatSummary(store.list());
    case 'done':
      return `done ${formatItem(store.complete(Number(rest[0])))}`;
    case 'rm':
      return `removed ${formatItem(store.remove(Number(rest[0])))}`;
    default:
      return USAGE;
  }
}

if (require.main === module) {
  try {
    console.log(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { main, parseArgs };
