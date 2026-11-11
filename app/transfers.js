/* Background image previews share one bounded scheduler. Explicit transfers hold
 * a priority lease that aborts background requests until the transfer finishes. */
(function () {
  'use strict';
  class PreviewScheduler {
    constructor(root) {
      this.targets = new Map();
      this.active = new Map();
      this.cache = new Map();
      this.cacheBytes = 0;
      this.leases = 0;
      this.frame = null;
      this.root = root;
      this.observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
          const target = this.targets.get(entry.target);
          if (target) target.visible = entry.isIntersecting;
        }
        this.schedule();
      }, { root, rootMargin: '180px' });
      this.mutations = new MutationObserver(() => this.schedule());
      this.mutations.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
      this.timer = setInterval(() => this.schedule(), 1000);
      window.addEventListener('pagehide', () => this.destroy(), { once: true });
    }
    schedule() {
      if (this.destroyed || this.frame !== null) return;
      const run = () => {
        if (this.frame === null) return;
        cancelAnimationFrame(this.frame); clearTimeout(this.fallback);
        this.frame = null; this.update();
      };
      this.frame = requestAnimationFrame(run);
      // Network work must progress even when Electron delays compositor frames.
      this.fallback = setTimeout(run, 100);
    }
    update() {
      const present = new Set(this.root.querySelectorAll('img[data-preview-id]'));
      for (const [img, target] of this.targets) if (!present.has(img)) {
        this.observer.unobserve(img);
        if (target.url) URL.revokeObjectURL(target.url);
        this.targets.delete(img);
      }
      for (const img of present) if (!this.targets.has(img)) {
        this.targets.set(img, { id: img.dataset.previewKey || img.dataset.previewId, requestId: img.dataset.previewId, visible: false, loaded: false, retryAt: 0, attempts: 0 });
        this.observer.observe(img);
      }
      // Read transformed geometry as well as IntersectionObserver. This handles
      // selected cards kept in the DOM, collapsed bodies, pan, zoom and groups.
      const eligible = [];
      const viewport = this.root.getBoundingClientRect();
      const inset = (this.root.style.clipPath?.match(/[\d.]+/g) || ['0', '0']).map(Number);
      for (const [img, target] of this.targets) {
        const r = img.getBoundingClientRect();
        const near = r.width > 0 && r.height > 0 && r.right > viewport.left + inset[1] - 180 && r.left < viewport.right - inset[1] + 180 && r.bottom > viewport.top + inset[0] - 180 && r.top < viewport.bottom - inset[0] + 180;
        target.visible = near;
        if (!near && target.url) {
          URL.revokeObjectURL(target.url); target.url = null; target.loaded = false; img.removeAttribute('src');
        }
        if (near && !target.loaded && target.attempts < 6) eligible.push([img, target, Math.abs(r.left - innerWidth / 2) + Math.abs(r.top - innerHeight / 2)]);
      }
      eligible.sort((a, b) => a[2] - b[2]);
      // Recompute a maximum 24-entry queue; never accumulate pan history.
      const queue = eligible.slice(0, 24);
      const wanted = new Set(queue.map(([, target]) => target.id));
      for (const [id, job] of this.active) if (this.leases || !wanted.has(id)) job.controller.abort();
      if (this.leases) return;
      for (const [img, target] of queue) {
        const cached = this.cache.get(target.id);
        if (cached) { this.display(img, target, cached); continue; }
        if (this.active.size >= 2) break;
        if (this.active.has(target.id) || target.retryAt > Date.now()) continue;
        this.load(target.id, target.requestId);
      }
    }
    display(img, target, blob) {
      if (!img.isConnected || this.targets.get(img) !== target || target.loaded) return;
      target.url = URL.createObjectURL(blob);
      img.src = target.url;
      target.loaded = true;
      img.alt = img.dataset.filename || 'Image preview';
    }
    async load(id, requestId) {
      const job = { controller: new AbortController() };
      this.active.set(id, job);
      try {
        const res = await fetch('/previews/' + encodeURIComponent(requestId), { signal: job.controller.signal, priority: 'low' });
        if (res.status === 202 || res.status === 503) {
          for (const target of this.targets.values()) if (target.id === id) { target.retryAt = Date.now() + 2000; target.attempts++; }
          return;
        }
        if (!res.ok) throw new Error('Preview unavailable');
        const blob = await res.blob();
        if (job.controller.signal.aborted || this.active.get(id) !== job) return;
        if (blob.size > 96 * 1024 || blob.type !== 'image/webp') throw new Error('Invalid preview');
        this.cache.set(id, blob); this.cacheBytes += blob.size;
        while (this.cache.size > 64 || this.cacheBytes > 8 * 1024 * 1024) {
          const key = this.cache.keys().next().value;
          this.cacheBytes -= this.cache.get(key).size; this.cache.delete(key);
        }
        for (const [img, target] of this.targets) if (target.id === id && target.visible) this.display(img, target, blob);
      } catch (err) {
        if (err.name !== 'AbortError') for (const [img, target] of this.targets) if (target.id === id) {
          target.attempts = 6; img.alt = 'Preview unavailable — download the original';
        }
      } finally {
        if (this.active.get(id) === job) this.active.delete(id);
        this.schedule();
      }
    }
    refresh(id) {
      for (const target of this.targets.values()) if (target.requestId === id || target.id === id) { target.retryAt = 0; target.attempts = 0; }
      this.schedule();
    }
    priority() {
      this.leases++;
      for (const job of this.active.values()) job.controller.abort();
      let released = false;
      return () => { if (!released) { released = true; this.leases--; this.schedule(); } };
    }
    destroy() {
      this.destroyed = true;
      clearInterval(this.timer);
      if (this.frame !== null) cancelAnimationFrame(this.frame);
      clearTimeout(this.fallback);
      this.observer.disconnect(); this.mutations.disconnect();
      for (const job of this.active.values()) job.controller.abort();
      for (const target of this.targets.values()) if (target.url) URL.revokeObjectURL(target.url);
      this.targets.clear(); this.cache.clear();
    }
  }
  window.RiftPreviewScheduler = PreviewScheduler;
})();
