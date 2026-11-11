'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { createHash } = require('node:crypto');

class Thumbnails {
  constructor(directory, onReady) {
    this.directory = directory;
    this.onReady = onReady;
    this.queue = new Map();
    this.active = null;
    fs.mkdirSync(directory, { recursive: true });
    // Only our own incomplete worker outputs, never originals.
    for (const name of fs.readdirSync(directory)) if (name.endsWith('.tmp')) fs.rmSync(path.join(directory, name), { force: true });
  }

  paths(identity) {
    const key = createHash('sha256').update(identity).digest('hex');
    return { output: path.join(this.directory, key + '.webp'), failure: path.join(this.directory, key + '.failed') };
  }

  request(identity, input) {
    const paths = this.paths(identity);
    if (fs.existsSync(paths.output)) return { status: 200, path: paths.output };
    if (fs.existsSync(paths.failure)) return { status: 422 };
    if (this.active?.identity === identity || this.queue.has(identity)) return { status: 202 };
    if (this.queue.size >= 32) return { status: 503 };
    if (fs.statSync(input).size > 25 * 1024 * 1024) {
      fs.writeFileSync(paths.failure, 'Preview input exceeds 25 MiB');
      return { status: 422 };
    }
    this.queue.set(identity, { identity, input, ...paths });
    this.pump();
    return { status: 202 };
  }

  pump() {
    if (this.active || !this.queue.size) return;
    const job = this.queue.values().next().value;
    this.queue.delete(job.identity);
    const temporary = job.output + '.tmp';
    const worker = fork(path.join(__dirname, 'thumbnail-worker.js'), [], { execArgv: ['--max-old-space-size=128'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    this.active = { ...job, worker };
    let finished = false;
    const finish = ok => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      worker.kill();
      const current = this.active;
      this.active = null;
      if (!current?.cancelled && fs.existsSync(job.input)) {
        if (ok && fs.existsSync(temporary)) {
          fs.renameSync(temporary, job.output);
          this.onReady(job.identity);
        } else fs.writeFileSync(job.failure, 'Preview unavailable');
      }
      fs.rmSync(temporary, { force: true });
      this.pump();
    };
    const timeout = setTimeout(() => finish(false), 10000);
    worker.once('message', result => finish(result.ok));
    worker.once('error', () => finish(false));
    worker.once('exit', () => finish(false));
    worker.send({ input: job.input, output: temporary });
  }

  remove(identity) {
    this.queue.delete(identity);
    if (this.active?.identity === identity) { this.active.cancelled = true; this.active.worker.kill(); }
    const paths = this.paths(identity);
    for (const p of [paths.output, paths.failure]) fs.rmSync(p, { force: true });
  }
}

module.exports = { Thumbnails };
