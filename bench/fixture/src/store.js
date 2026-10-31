'use strict';
const fs = require('fs');

/**
 * A todo item: { id: number, text: string, done: boolean, createdAt: string }
 */
class Store {
  constructor(file) {
    this.file = file;
    this.items = [];
    this.load();
  }

  load() {
    try {
      this.items = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.items = [];
    }
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.items, null, 2));
  }

  nextId() {
    return this.items.reduce((m, t) => Math.max(m, t.id), 0) + 1;
  }

  add(text) {
    if (!text || !text.trim()) throw new Error('todo text is required');
    const item = { id: this.nextId(), text: text.trim(), done: false, createdAt: new Date().toISOString() };
    this.items.push(item);
    this.save();
    return item;
  }

  list() {
    return this.items.slice();
  }

  complete(id) {
    const item = this.items.find(t => t.id === id);
    if (!item) throw new Error(`no todo with id ${id}`);
    item.done = true;
    this.save();
    return item;
  }

  remove(id) {
    const idx = this.items.findIndex(t => t.id === id);
    if (idx === -1) throw new Error(`no todo with id ${id}`);
    const [item] = this.items.splice(idx, 1);
    this.save();
    return item;
  }
}

module.exports = { Store };
