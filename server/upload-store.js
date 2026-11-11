'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');

function atomicJSON(file, value) {
  const temp = file + '.tmp';
  const fd = fs.openSync(temp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

class UploadStore {
  constructor(directory, items) {
    this.directory = directory;
    this.files = path.join(directory, 'files');
    this.temporary = path.join(directory, 'upload-tmp');
    fs.mkdirSync(this.temporary, { recursive: true });
    this.journal = path.join(directory, 'uploads.json');
    this.items = items;
    // An unreadable journal is a startup error: never silently lose reconciliation.
    this.records = fs.existsSync(this.journal) ? JSON.parse(fs.readFileSync(this.journal)) : {};
    this.active = new Map();
    for (const [key, record] of Object.entries(this.records)) if (process.env.RIFT_MAINTENANCE !== '1' && record.status === 'receiving') {
      fs.rmSync(path.join(this.files, record.storedName), { force: true });
      delete this.records[key];
    }
    if (process.env.RIFT_MAINTENANCE !== '1') {
      for (const name of fs.readdirSync(this.temporary)) if (/^[0-9a-f-]{36}\.part$/.test(name)) fs.rmSync(path.join(this.temporary, name), { force: true });
      this.sweep();
    }
    this.timer = setInterval(() => { if (process.env.RIFT_MAINTENANCE !== '1') this.sweep(); }, 60000).unref();
  }
  save() { atomicJSON(this.journal, this.records); }
  get(key) { return this.records[key]; }
  cancelled(key) { return ['cancelled', 'deleted'].includes(this.get(key)?.status); }
  async receive(key, data, req, workspaceId = 'inbox') {
    const started = performance.now();
    let bodyEnded = started;
    const received = () => { bodyEnded = performance.now(); };
    data.file.once('end', received);
    const id = randomUUID();
    const storedName = id + path.extname(data.filename || '').slice(0, 32).toLowerCase();
    const temporary = path.join(this.temporary, id + '.part');
    const final = path.join(this.files, storedName);
    const controller = new AbortController();
    this.records[key] = { id, storedName, workspaceId, status: 'receiving', updatedAt: Date.now() };
    this.save();
    this.active.set(key, controller);
    const abort = () => controller.abort();
    const inactive = () => { controller.abort(); req.raw.destroy(); };
    req.raw.once('aborted', abort);
    req.raw.setTimeout(120000, inactive);
    try {
      await pipeline(data.file, fs.createWriteStream(temporary, { flags: 'wx', flush: true, mode: 0o600 }), { signal: controller.signal });
      if (data.file.truncated) { const e = new Error('File exceeds 100 MiB limit'); e.statusCode = 413; throw e; }
      if (this.cancelled(key)) { const e = new Error('Upload cancelled'); e.statusCode = 410; throw e; }
      const result = { id, storedName, workspaceId, fileName: data.filename, fileSize: fs.statSync(temporary).size, mimeType: data.mimetype, status: 'stored', updatedAt: Date.now() };
      fs.renameSync(temporary, final);
      const directory = fs.openSync(this.files, 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      this.records[key] = result;
      this.save();
      return { record: result, bodyMs: bodyEnded - started, storeMs: performance.now() - bodyEnded };
    } catch (e) {
      fs.rmSync(temporary, { force: true });
      fs.rmSync(final, { force: true });
      if (this.records[key]?.id === id) { delete this.records[key]; this.save(); }
      throw e;
    } finally {
      data.file.removeListener('end', received); req.raw.removeListener('aborted', abort);
      req.raw.removeListener('timeout', inactive); req.raw.setTimeout(0);
      this.active.delete(key);
    }
  }
  cancel(key) {
    const record = this.get(key);
    if (record && [...this.items.values()].some(item => item.content === record.storedName)) return false;
    this.active.get(key)?.abort();
    this.records[key] = { status: 'cancelled', updatedAt: Date.now() };
    this.save();
    if (record?.storedName) fs.rmSync(path.join(this.files, record.storedName), { force: true });
    return true;
  }
  remove(storedName, itemId) {
    for (const record of Object.values(this.records)) if (record.storedName === storedName && (!itemId || record.id === itemId)) {
      record.status = 'deleted'; record.updatedAt = Date.now();
    }
    this.save();
  }
  sweep() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [key, record] of Object.entries(this.records)) {
      if (this.cancelled(key)) {
        if (record.storedName && ![...this.items.values()].some(item => item.content === record.storedName)) fs.rmSync(path.join(this.files, record.storedName), { force: true });
        continue;
      }
      if (record.updatedAt >= cutoff || this.active.has(key)) continue;
      const attached = [...this.items.values()].some(item => item.content === record.storedName);
      if (!attached && record.storedName) fs.rmSync(path.join(this.files, record.storedName), { force: true });
      if (attached) record.status = 'completed';
      else this.records[key] = { status: 'deleted', updatedAt: Date.now() };
      // Keep completed identities and compact tombstones so a very late retry
      // can never create a second attachment with the same operation key.
    }
    this.save();
  }
}

module.exports = { UploadStore, atomicJSON };
