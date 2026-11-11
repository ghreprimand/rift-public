(function () {
  'use strict';
  class Outbox {
    constructor(transmit, changed) {
      this.transmit = transmit;
      this.changed = changed;
      this.key = 'rift:outbox:v2';
      this.pending = [];
      this.connected = false;
      this.inflight = null;
      this.warning = '';
      try {
        const stored = JSON.parse(localStorage.getItem(this.key) || '[]');
        if (!Array.isArray(stored)) throw new Error('Invalid outbox');
        this.pending = stored.filter(op => op && typeof op.operationId === 'string' && op.message && typeof op.message.type === 'string');
      } catch {
        // Preserve the original value for manual recovery rather than overwrite it.
        try { this.recovery = localStorage.getItem(this.key); } catch { this.recovery = ''; }
        this.key = 'rift:outbox:recovery:' + Date.now();
        this.warning = 'Stored drafts need recovery. Keep this window open.';
      }
    }
    save() {
      try {
        const data = JSON.stringify(this.pending);
        if (data.length > 2 * 1024 * 1024) throw new Error('Draft budget');
        localStorage.setItem(this.key, data);
        if (!this.recovery) this.warning = '';
      } catch { this.warning = 'Drafts are only in memory. Copy them before closing Rift.'; }
      this.changed();
    }
    enqueue(message) {
      const operationId = crypto.randomUUID();
      const blocked = new TextEncoder().encode(JSON.stringify(message)).length > 240 * 1024;
      this.pending.push({ operationId, message: { ...message, operationId }, blocked, ...(blocked && { error: 'This edit exceeds the message limit. Copy the draft into smaller notes.' }) });
      this.save(); this.pump();
    }
    ready() { this.connected = true; this.inflight = null; this.pump(); this.changed(); }
    offline() { this.connected = false; this.inflight = null; this.changed(); }
    pump() {
      if (!this.connected || this.inflight) return;
      const elapsed = Date.now() - (this.lastSent || 0);
      if (elapsed < 16) {
        if (!this.pumpTimer) this.pumpTimer = setTimeout(() => { this.pumpTimer = null; this.pump(); }, 16 - elapsed);
        return;
      }
      const seen = new Set();
      const operation = this.pending.find(op => {
        const id = op.message.id || op.message.item?.id || op.message.group?.id;
        if (id && seen.has(id)) return false;
        if (id) seen.add(id);
        return !op.blocked;
      });
      if (!operation) return;
      this.inflight = operation.operationId;
      this.lastSent = Date.now();
      this.transmit(operation.message);
    }
    acknowledge(message) {
      const operation = this.pending.find(op => op.operationId === message.operationId);
      if (!operation) return;
      this.pending = this.pending.filter(op => op !== operation);
      const id = operation.message.id || operation.message.item?.id;
      for (const queued of this.pending) if (id && queued.message.id === id
          && (queued.message.expectedVersion || 0) === (operation.message.expectedVersion || 0)
          && message.version !== undefined) queued.message.expectedVersion = message.appliedVersion ?? message.version;
      this.inflight = null; this.save(); this.pump();
    }
    conflict(message) {
      const operation = this.pending.find(op => op.operationId === message.operationId);
      if (operation) { operation.blocked = true; operation.error = message.error; operation.current = message.item; }
      this.inflight = null; this.save(); this.pump();
    }
    remove(operationId) {
      this.pending = this.pending.filter(op => op.operationId !== operationId);
      if (this.inflight === operationId) this.inflight = null;
      this.save(); this.pump();
    }
    retry(operationId) {
      const operation = this.pending.find(op => op.operationId === operationId);
      if (!operation) return;
      operation.blocked = false;
      if (operation.current?.version !== undefined) operation.message.expectedVersion = operation.current.version;
      this.save(); this.pump();
    }
  }
  window.RiftOutbox = Outbox;
})();
