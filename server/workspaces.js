'use strict';

const { randomUUID } = require('node:crypto');
const clone = value => JSON.parse(JSON.stringify(value));
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) && !Object.getOwnPropertyNames(Object.prototype).includes(value) && value !== 'prototype';
const fail = message => { throw new Error(message); };
const defaultView = () => ({ camera: null, selection: [], query: '', kind: 'all', scope: 'workspace', pinned: false, collection: 'active', mode: 'canvas', sort: 'newest', after: '', page: 0, transfers: false, libraryAnchor: null });

class Workspaces {
  constructor(raw, items, groups) {
    if (raw.schemaVersion && raw.schemaVersion > 2) fail('Unsupported workspace schema');
    this.items = items;
    this.groups = groups;
    this.workspaces = raw.workspaces || [{ id: 'inbox', name: 'Inbox', archived: false, createdAt: Date.now() }];
    if (!Array.isArray(this.workspaces) || !this.workspaces.some(w => w.id === 'inbox')) fail('Invalid workspace catalog');
    if (new Set(this.workspaces.map(w => w.id)).size !== this.workspaces.length || this.workspaces.some(w => !identifier(w.id))) fail('Invalid workspace IDs');
    for (const item of items.values()) {
      if (raw.schemaVersion === 2 && !item.workspaceId) fail('Missing card workspace');
      item.workspaceId ||= 'inbox'; item.version ||= 1;
      if (!this.exists(item.workspaceId)) fail('Card references an unknown workspace');
    }
    for (const group of groups()) {
      if (raw.schemaVersion === 2 && !group.workspaceId) fail('Missing group workspace');
      group.workspaceId ||= 'inbox'; group.version ||= 1;
      if (!this.exists(group.workspaceId) || !Array.isArray(group.cards)
          || group.cards.some(id => items.has(id) && items.get(id).workspaceId !== group.workspaceId)) fail('Invalid workspace group');
    }
    this.session = raw.session || { tabs: ['inbox'], activeWorkspaceId: 'inbox', closedTabs: [], views: {} };
    this.session.views ||= {};
    if (typeof this.session.views !== 'object' || Array.isArray(this.session.views)) fail('Invalid shared views');
    this.session.closedTabs ||= [];
    for (const workspace of this.workspaces) this.session.views[workspace.id] = { ...defaultView(), ...this.session.views[workspace.id] };
    if (!this.session.tabs?.length || this.session.tabs.some(id => !this.exists(id)) || !this.session.tabs.includes(this.session.activeWorkspaceId)) fail('Invalid shared session');
    this.revision = raw.revision || 0;
    this.purged = Object.assign(Object.create(null), raw.purgedItems || {});
    this.lease = null;
  }
  exists(id) { return this.workspaces.find(workspace => workspace.id === id); }
  state() { return { schemaVersion: 2, workspaces: this.workspaces, session: this.session, revision: this.revision, purgedItems: this.purged }; }
  catalog() {
    return this.workspaces.map(workspace => {
      const cards = [...this.items.values()].filter(item => item.workspaceId === workspace.id);
      return { ...workspace, count: cards.filter(i => !i.trashedAt && !i.archived).length, archivedCount: cards.filter(i => !i.trashedAt && i.archived).length, trashCount: cards.filter(i => i.trashedAt).length };
    });
  }
  snapshot(modern = false) {
    const workspaceId = modern ? this.session.activeWorkspaceId : 'inbox';
    const items = [...this.items.values()].filter(item => item.workspaceId === workspaceId && (modern || (!item.trashedAt && !item.archived)));
    const ids = new Set(items.map(item => item.id));
    const groups = this.groups().filter(group => group.workspaceId === workspaceId).map(group => ({ ...group, cards: group.cards.filter(id => ids.has(id)) }));
    return { type: 'sync', supportsAck: true, items, groups,
      ...(modern && { protocolVersion: 2, workspaceId, workspaces: this.catalog(), session: clone(this.session), revision: this.revision }) };
  }
  sessionMessage() {
    return { type: 'session', session: clone(this.session), revision: this.revision, lease: this.lease && this.lease.until > Date.now() ? { owner: this.lease.owner, remainingMs: this.lease.until - Date.now() } : null };
  }
  workspaceCommand(message) {
    const { type, id } = message;
    if (type === 'workspaceCreate') {
      if (!identifier(id) || id === 'inbox') fail('Invalid workspace ID');
      const name = this.name(message.name);
      if (this.exists(id)) return;
      this.workspaces.push({ id, name, archived: false, createdAt: Date.now() });
      this.session.views[id] = defaultView();
      this.open(id);
    } else if (type === 'workspaceRename') {
      const workspace = this.exists(id);
      if (!workspace || id === 'inbox') fail('Inbox cannot be renamed');
      workspace.name = this.name(message.name, id);
    } else if (type === 'workspaceArchive' || type === 'workspaceRestore') {
      const workspace = this.exists(id);
      if (!workspace || id === 'inbox') fail('Inbox cannot be archived');
      workspace.archived = type === 'workspaceArchive';
      if (workspace.archived) this.close(id);
      else this.open(id);
    } else if (type === 'tabOpen' || type === 'workspaceActivate') {
      if (message.focusId && (!this.items.has(message.focusId) || this.items.get(message.focusId).workspaceId !== id || this.items.get(message.focusId).trashedAt)) fail('Search result is unavailable');
      if (message.query !== undefined && (typeof message.query !== 'string' || message.query.length > 512)) fail('Invalid search');
      this.open(id);
      if (message.focusId) {
        const item = this.items.get(message.focusId);
        if (!item || item.workspaceId !== id || item.trashedAt) fail('Search result is unavailable');
        const view = this.session.views[id];
        const width = Math.max(600, (item.width || 320) + 160);
        // Pan canvas to center this card
        view.camera = { cx: item.x + (item.width || 320) / 2, cy: item.y + (item.height || 200) / 2, width, height: width / 1.6 };
        view.selection = [item.id]; view.mode = 'canvas'; view.collection = item.archived ? 'archive' : 'active';
        view.kind = 'all'; view.pinned = false; view.after = '';
        view.page = 0; view.libraryAnchor = null;
        if (message.query !== undefined) { if (typeof message.query !== 'string' || message.query.length > 512) fail('Invalid search'); view.query = message.query; view.scope = message.scope === 'all' ? 'all' : 'workspace'; }
      }
    }
    else if (type === 'tabClose') this.close(id);
    else if (type === 'tabReopen') {
      const id = this.session.closedTabs.pop();
      if (id && this.exists(id) && !this.exists(id).archived) this.open(id);
    } else if (type === 'tabReorder') {
      if (!Array.isArray(message.tabs) || message.tabs.length !== this.session.tabs.length
          || new Set(message.tabs).size !== message.tabs.length || message.tabs.some(id => !this.session.tabs.includes(id))) fail('Invalid tab order');
      this.session.tabs = [...message.tabs];
    } else fail('Unknown workspace command');
    this.revision++;
    this.lease = null;
  }
  name(value, except) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) fail('Workspace names must contain 1–80 characters');
    const name = value.trim().normalize('NFC');
    if (this.workspaces.some(w => w.id !== except && w.name.toLowerCase() === name.toLowerCase())) fail('A workspace already has that name');
    return name;
  }
  open(id) {
    if (!this.exists(id) || this.exists(id).archived) fail('Workspace is unavailable');
    if (!this.session.tabs.includes(id)) this.session.tabs.push(id);
    this.session.activeWorkspaceId = id;
  }
  close(id) {
    const index = this.session.tabs.indexOf(id);
    if (index < 0) return;
    this.session.tabs.splice(index, 1);
    this.session.closedTabs = [...this.session.closedTabs.filter(other => other !== id), id].slice(-20);
    if (!this.session.tabs.length) this.session.tabs = ['inbox'];
    if (this.session.activeWorkspaceId === id) this.session.activeWorkspaceId = this.session.tabs[Math.min(index, this.session.tabs.length - 1)];
  }
  updateView(message, clientId) {
    const workspaceId = message.workspaceId || this.session.activeWorkspaceId;
    if (workspaceId !== this.session.activeWorkspaceId) return false;
    const patch = message.patch || {};
    const view = clone(this.session.views[workspaceId]);
    if (this.lease?.owner !== clientId && this.lease?.until > Date.now() && !message.takeControl) return false;
    if (patch.camera && message.initial && view.camera) return false;
    if (patch.camera) {
      const camera = patch.camera;
      if (!['cx', 'cy', 'width', 'height'].every(key => Number.isFinite(camera[key]))
          || Math.abs(camera.cx) > 1e7 || Math.abs(camera.cy) > 1e7 || camera.width < 20 || camera.height < 20 || camera.width > 1e7 || camera.height > 1e7) fail('Invalid shared camera');
      view.camera = { cx: camera.cx, cy: camera.cy, width: camera.width, height: camera.height };
    }
    if (patch.selection !== undefined) {
      if (!Array.isArray(patch.selection) || patch.selection.length > 5000 || patch.selection.some(id => typeof id !== 'string' || this.items.has(id) && this.items.get(id).workspaceId !== workspaceId)) fail('Invalid shared selection');
      view.selection = [...new Set(patch.selection)].filter(id => this.items.has(id) && !this.items.get(id).trashedAt);
    }
    if (patch.query !== undefined) { if (typeof patch.query !== 'string' || patch.query.length > 512) fail('Search is too long'); view.query = patch.query; }
    if (patch.after !== undefined) {
      if (typeof patch.after !== 'string' || patch.after && (!/^\d{4}-\d{2}-\d{2}$/.test(patch.after) || !Number.isFinite(Date.parse(patch.after + 'T00:00:00Z')) || new Date(patch.after + 'T00:00:00Z').toISOString().slice(0, 10) !== patch.after)) fail('Invalid date filter');
      view.after = patch.after;
    }
    if (patch.page !== undefined) { if (!Number.isSafeInteger(patch.page) || patch.page < 0 || patch.page > 100000) fail('Invalid results page'); view.page = patch.page; }
    if (patch.libraryAnchor !== undefined) {
      const anchor = patch.libraryAnchor;
      if (anchor !== null && (typeof anchor.id !== 'string' || !this.items.has(anchor.id) || !Number.isFinite(anchor.offset) || anchor.offset < 0 || anchor.offset > 1)) fail('Invalid library position');
      view.libraryAnchor = anchor === null ? null : { id: anchor.id, offset: anchor.offset };
    }
    for (const [key, values] of Object.entries({ kind: ['all', 'text', 'image', 'file', 'video', 'audio', 'pdf'], scope: ['workspace', 'all'], collection: ['active', 'archive', 'trash'], mode: ['canvas', 'library'], sort: ['newest', 'oldest', 'name'] })) {
      if (patch[key] !== undefined) { if (!values.includes(patch[key])) fail('Invalid view option'); view[key] = patch[key]; }
    }
    for (const key of ['pinned', 'transfers']) if (patch[key] !== undefined) { if (typeof patch[key] !== 'boolean') fail('Invalid view option'); view[key] = patch[key]; }
    this.session.views[workspaceId] = view;
    this.lease = message.release ? null : { owner: clientId, until: Date.now() + 1200 };
    this.revision++;
    return true;
  }
  search({ q = '', workspaceId, kind = 'all', pinned = false, collection = 'active', sort = 'newest', after = '', offset = 0, limit = 50 } = {}) {
    const query = String(q).normalize('NFKC').toLowerCase().slice(0, 512);
    let cards = [...this.items.values()].filter(item => (!workspaceId || item.workspaceId === workspaceId)
      && (collection === 'trash' ? !!item.trashedAt : !item.trashedAt && (collection === 'archive' ? !!item.archived || !!this.exists(item.workspaceId)?.archived : !item.archived && !this.exists(item.workspaceId)?.archived))
      && (!pinned || item.pinned)
      && (!after || (item.createdAt || 0) >= Date.parse(after + 'T00:00:00Z'))
      && (kind === 'all' || (kind === 'text' ? item.kind === 'text' : kind === 'file' ? item.kind === 'file' && !/^(audio\/|application\/pdf)/.test(item.mimeType || '') : kind === 'image' ? item.mimeType?.startsWith('image/') : kind === 'pdf' ? item.mimeType?.includes('pdf') : item.mimeType?.startsWith(kind + '/')))
      && (!query || [item.fileName, item.label, item.kind === 'text' && !item.hidden ? item.content : '', ...this.groups().filter(g => g.cards.includes(item.id)).map(g => g.label)].some(value => String(value || '').normalize('NFKC').toLowerCase().includes(query))));
    cards.sort((a, b) => sort === 'name' ? String(a.label || a.fileName || '').localeCompare(String(b.label || b.fileName || ''), 'en') || a.id.localeCompare(b.id, 'en') : (sort === 'oldest' ? 1 : -1) * ((a.createdAt || 0) - (b.createdAt || 0)) || a.id.localeCompare(b.id, 'en'));
    const total = cards.length;
    cards = cards.slice(Math.max(0, Number(offset) || 0), Math.max(0, Number(offset) || 0) + Math.min(100, Math.max(1, Number(limit) || 50)));
    return { total, results: cards.map(item => ({ ...item, content: item.kind === 'text' ? item.hidden ? '' : String(item.content || '').slice(0, 240) : undefined,
      workspaceName: this.exists(item.workspaceId)?.name, groupNames: this.groups().filter(group => group.cards.includes(item.id)).slice(0, 5).map(group => group.label) })) };
  }
}

module.exports = { Workspaces, defaultView, identifier };
