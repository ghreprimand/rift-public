(function () {
  'use strict';
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (label, action, className = '') => {
    const node = element('button', label, className);
    node.type = 'button'; node.addEventListener('click', action); return node;
  };
  class WorkspaceUI {
    constructor(hooks) {
      this.hooks = hooks;
      this.state = null;
      this.generation = 0;
      this.lastCatalog = '';
      this.lastSearch = '';
      document.getElementById('new-workspace').onclick = () => this.nameDialog();
      for (const mode of ['canvas', 'library']) document.getElementById('view-' + mode).onclick = () => hooks.view({ mode });
      document.getElementById('collection-active').onclick = () => hooks.view({ collection: 'active', page: 0, libraryAnchor: null });
      for (const collection of ['archive', 'trash']) document.getElementById('collection-' + collection).onclick = () => hooks.view({ collection, mode: 'library', page: 0, libraryAnchor: null });
      for (const field of ['scope', 'kind', 'sort']) document.getElementById('filter-' + field).onchange = event => hooks.view({ [field]: event.target.value, page: 0, libraryAnchor: null });
      document.getElementById('filter-toggle')?.addEventListener('click', () => document.getElementById('filter-options').togglePopover());
      document.getElementById('filter-after').onchange = event => hooks.view({ after: event.target.value, page: 0, libraryAnchor: null });
      document.getElementById('filter-pinned').onchange = event => hooks.view({ pinned: event.target.checked, page: 0, libraryAnchor: null });
      document.getElementById('show-transfers').onclick = () => hooks.view({ transfers: !this.view().transfers });
      document.getElementById('close-transfers').onclick = () => hooks.view({ transfers: false });
      document.getElementById('take-control').onclick = () => hooks.control();
      document.getElementById('library').onscroll = () => {
        if (Date.now() < (this.scrollBlockedUntil || 0)) return;
        this.localScrollUntil = Date.now() + 300;
        const publish = release => {
          const library = document.getElementById('library'), top = library.getBoundingClientRect().top;
          const row = [...library.querySelectorAll('.library-row')].find(row => row.getBoundingClientRect().bottom > top);
          if (row) { const bounds = row.getBoundingClientRect(); hooks.scroll({ libraryAnchor: { id: row.dataset.id, offset: Math.max(0, Math.min(1, (top - bounds.top) / bounds.height)) } }, { release }); }
        };
        if (!this.scrollTimer) this.scrollTimer = setTimeout(() => { this.scrollTimer = null; publish(false); }, 100);
        clearTimeout(this.scrollIdleTimer);
        this.scrollIdleTimer = setTimeout(() => { this.localScrollUntil = 0; publish(true); }, 260);
      };
      document.getElementById('reopen-tab').onclick = () => hooks.command({ type: 'tabReopen' });
      document.getElementById('bulk-archive').onclick = () => this.selected().forEach(item => hooks.command({ type: 'archive', id: item.id, archived: !item.archived }));
      document.getElementById('bulk-trash').onclick = () => {
        const selection = this.selected();
        if (selection.length && confirm('Move ' + selection.length + ' cards to Trash?')) selection.forEach(item => hooks.command({ type: 'delete', id: item.id }));
      };
      document.getElementById('bulk-move').onchange = event => {
        if (!event.target.value) return;
        hooks.command({ type: 'moveWorkspace', cards: this.selected().map(item => item.id), destination: event.target.value });
        event.target.value = '';
      };
    }
    openDialog({ title, label, submit, value = '', choices, validate, action }) {
      if (document.getElementById('workspace-dialog')) return;
      const opener = document.activeElement;
      const dialog = element('dialog'); dialog.id = 'workspace-dialog';
      dialog.setAttribute('aria-labelledby', 'workspace-dialog-title');
      const form = element('form'); form.noValidate = true;
      const heading = element('h2', title); heading.id = 'workspace-dialog-title';
      const fieldLabel = element('label', label); fieldLabel.htmlFor = 'workspace-dialog-field';
      const field = element(choices ? 'select' : 'input'); field.id = 'workspace-dialog-field';
      field.required = true; field.setAttribute('aria-describedby', 'workspace-dialog-error');
      if (choices) {
        for (const choice of choices) { const option = element('option', choice.name); option.value = choice.id; field.append(option); }
      } else { field.type = 'text'; field.maxLength = 80; field.autocomplete = 'off'; }
      field.value = value || (choices?.[0]?.id || '');
      const error = element('p', '', 'dialog-error'); error.id = 'workspace-dialog-error'; error.setAttribute('role', 'alert');
      const actions = element('div', undefined, 'dialog-actions');
      const cancel = button('Cancel', () => dialog.close());
      const accept = element('button', submit); accept.type = 'submit';
      actions.append(cancel, accept); form.append(heading, fieldLabel, field, error, actions); dialog.append(form);
      form.onsubmit = event => {
        event.preventDefault();
        if (!dialog.open) return;
        const problem = validate(field.value);
        if (problem) { error.textContent = problem; field.setAttribute('aria-invalid', 'true'); field.focus(); return; }
        dialog.close(); action(field.value);
      };
      field.oninput = () => { error.textContent = ''; field.removeAttribute('aria-invalid'); };
      // Keep canvas shortcuts from acting behind the modal, including Escape.
      dialog.addEventListener('keydown', event => event.stopPropagation());
      dialog.addEventListener('paste', event => event.stopPropagation());
      dialog.addEventListener('close', () => { dialog.remove(); if (opener?.isConnected) opener.focus(); }, { once: true });
      document.body.append(dialog); dialog.showModal(); field.focus(); if (!choices) field.select();
    }
    nameDialog(workspace) {
      this.openDialog({
        title: workspace ? 'Rename workspace' : 'New workspace', label: 'Workspace name',
        submit: workspace ? 'Save' : 'Create workspace', value: workspace?.name || '',
        validate: value => {
          const name = value.trim().normalize('NFC');
          if (!name || name.length > 80) return 'Enter a workspace name with 1–80 characters.';
          if (this.state?.workspaces.some(other => other.id !== workspace?.id && other.name.toLowerCase() === name.toLowerCase())) return 'A workspace already has that name.';
        },
        action: value => this.hooks.command({ type: workspace ? 'workspaceRename' : 'workspaceCreate', id: workspace?.id || crypto.randomUUID(), name: value.trim().normalize('NFC') }),
      });
    }
    moveDialog(card) {
      const choices = (this.state?.workspaces || []).filter(workspace => workspace.id !== card.workspaceId && !workspace.archived);
      if (!choices.length) return;
      this.openDialog({
        title: 'Move to workspace', label: 'Destination workspace', submit: 'Move card and group', choices,
        validate: id => { if (!this.state.workspaces.some(workspace => workspace.id === id && !workspace.archived && id !== card.workspaceId)) return 'Choose an available workspace.'; },
        action: destination => this.hooks.command({ type: 'moveWorkspace', workspaceId: card.workspaceId, cards: [card.id], destination }),
      });
    }
    view() { return this.state?.session?.views[this.state.workspaceId] || {}; }
    selected() { return (this.state?.items || []).filter(item => this.view().selection?.includes(item.id) && !item.trashedAt); }
    update(state) {
      if (this.state?.connected !== state.connected) this.lastSearch = '';
      this.state = state;
      const view = this.view();
      const fingerprint = JSON.stringify([state.workspaces, state.session.tabs, state.workspaceId]);
      if (fingerprint !== this.lastCatalog) { this.lastCatalog = fingerprint; this.renderCatalog(); }
      document.getElementById('workspace-title').textContent = state.workspaces.find(w => w.id === state.workspaceId)?.name || 'Inbox';
      document.getElementById('filter-scope').value = view.scope || 'workspace';
      document.getElementById('filter-kind').value = view.kind || 'all';
      document.getElementById('filter-sort').value = view.sort || 'newest';
      document.getElementById('filter-after').value = view.after || '';
      document.getElementById('filter-pinned').checked = !!view.pinned;
      const filterButton = document.getElementById('filter-toggle');
      const activeFilters = Number(view.kind !== 'all') + Number(!!view.pinned) + Number(!!view.after) + Number(view.sort !== 'newest');
      if (filterButton) filterButton.textContent = activeFilters ? 'Filters · ' + activeFilters : 'Filters';
      document.getElementById('search-input').value = view.query || '';
      for (const mode of ['canvas', 'library']) document.getElementById('view-' + mode).setAttribute('aria-pressed', String(view.mode === mode));
      for (const collection of ['active', 'archive', 'trash']) document.getElementById('collection-' + collection).classList.toggle('active', view.collection === collection);
      document.getElementById('bulk-actions').hidden = !this.selected().length;
      document.getElementById('bulk-count').textContent = this.selected().length + ' selected';
      for (const row of document.querySelectorAll('#library .library-row')) {
        const checkbox = row.querySelector('input[type="checkbox"]');
        if (checkbox) checkbox.checked = !!view.selection?.includes(row.dataset.id);
      }
      document.getElementById('transfer-drawer').hidden = !view.transfers;
      document.getElementById('library').hidden = view.mode !== 'library';
      document.getElementById('search-results').hidden = !view.query || view.mode === 'library';
      document.getElementById('sync-status').textContent = state.warning || (!state.connected ? 'Offline · edits retained locally' : state.pending ? state.pending + ' edits awaiting confirmation' : 'Synced');
      document.getElementById('sync-status').classList.toggle('unsaved', !state.connected || !!state.pending || !!state.warning);
      const following = state.lease && state.lease.owner !== state.clientId && state.lease.until > Date.now();
      if (following) this.localScrollUntil = 0;
      document.getElementById('take-control').hidden = !following;
      clearTimeout(this.leaseTimer);
      if (following) this.leaseTimer = setTimeout(() => { document.getElementById('take-control').hidden = true; }, Math.max(0, state.lease.until - Date.now()));
      this.refreshSearch();
      this.applyScroll();
      this.renderTransfers();
    }
    renderCatalog() {
      const state = this.state;
      const list = document.getElementById('workspace-list'); list.replaceChildren();
      const archived = document.getElementById('archived-workspaces'); archived.replaceChildren();
      const tabs = document.getElementById('workspace-tabs'); tabs.replaceChildren();
      const move = document.getElementById('bulk-move'); move.replaceChildren(element('option', 'Move to workspace…')); move.firstChild.value = '';
      for (const workspace of state.workspaces) {
        const row = element('div', undefined, 'workspace-row');
        row.dataset.workspace = workspace.id;
        const open = button(workspace.name + '  ' + workspace.count, () => this.hooks.command({ type: workspace.archived ? 'workspaceRestore' : 'tabOpen', id: workspace.id }), workspace.id === state.workspaceId ? 'active' : '');
        open.title = workspace.archived ? 'Restore workspace' : 'Open workspace'; row.append(open);
        if (workspace.id !== 'inbox') {
          const menu = element('details'); const summary = element('summary', '⋯'); summary.setAttribute('aria-label', 'Workspace actions'); menu.append(summary);
          const actions = element('div', undefined, 'workspace-menu');
          actions.append(button('Rename', () => this.nameDialog(workspace)));
          actions.append(button(workspace.archived ? 'Restore' : 'Archive workspace', () => {
            if (workspace.archived || confirm('Archive ' + workspace.name + '? Its cards and files will be retained.')) this.hooks.command({ type: workspace.archived ? 'workspaceRestore' : 'workspaceArchive', id: workspace.id });
          }));
          menu.append(actions); row.append(menu);
        }
        (workspace.archived ? archived : list).append(row);
        if (!workspace.archived && workspace.id !== state.workspaceId) { const option = element('option', workspace.name); option.value = workspace.id; move.append(option); }
      }
      document.getElementById('archived-workspaces-label').hidden = !archived.children.length;
      for (const id of state.session.tabs) {
        const workspace = state.workspaces.find(w => w.id === id); if (!workspace) continue;
        const tab = element('div', undefined, 'workspace-tab'); tab.dataset.workspace = id; tab.draggable = true;
        const activate = button(workspace.name, () => this.hooks.command({ type: 'workspaceActivate', id }), id === state.workspaceId ? 'active' : '');
        activate.setAttribute('role', 'tab'); activate.setAttribute('aria-selected', String(id === state.workspaceId));
        activate.onkeydown = event => {
          if (!event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
          event.preventDefault(); const order = [...state.session.tabs], from = order.indexOf(id), to = Math.max(0, Math.min(order.length - 1, from + (event.key === 'ArrowLeft' ? -1 : 1)));
          order.splice(from, 1); order.splice(to, 0, id); this.hooks.command({ type: 'tabReorder', tabs: order });
        };
        const close = button('×', () => this.hooks.command({ type: 'tabClose', id })); close.setAttribute('aria-label', 'Close ' + workspace.name + ' tab');
        tab.append(activate, close);
        tab.ondragstart = event => { event.dataTransfer.setData('application/x-rift-tab', id); event.dataTransfer.effectAllowed = 'move'; };
        tab.ondragover = event => { if (event.dataTransfer.types.includes('application/x-rift-tab')) event.preventDefault(); };
        tab.ondrop = event => {
          event.preventDefault(); event.stopPropagation(); const from = event.dataTransfer.getData('application/x-rift-tab');
          if (!state.session.tabs.includes(from)) return;
          const order = state.session.tabs.filter(other => other !== from); order.splice(order.indexOf(id), 0, from);
          this.hooks.command({ type: 'tabReorder', tabs: order });
        };
        tabs.append(tab);
      }
    }
    refreshSearch() {
      if (!this.state) return;
      const view = this.view();
      const fingerprint = JSON.stringify([this.state.workspaceId, view.query, view.scope, view.kind, view.pinned, view.collection, view.sort, view.after, view.page, this.state.items.map(item => [item.id, item.version, item.trashedAt, item.archived]), this.state.workspaces]);
      if (fingerprint === this.lastSearch) return;
      this.lastSearch = fingerprint;
      clearTimeout(this.searchTimer); this.searchController?.abort();
      const generation = ++this.generation;
      this.searchTimer = setTimeout(async () => {
        const controller = this.searchController = new AbortController();
        try {
          const params = new URLSearchParams({ q: view.query || '', scope: view.scope || 'workspace', workspaceId: this.state.workspaceId, kind: view.kind || 'all', pinned: String(!!view.pinned), collection: view.collection || 'active', sort: view.sort || 'newest', after: view.after || '', offset: String((view.page || 0) * 100), limit: '100' });
          const response = await fetch('/search?' + params, { signal: controller.signal, cache: 'no-store' });
          if (!response.ok) throw new Error('Search is unavailable');
          const result = await response.json();
          if (generation !== this.generation) return;
          this.hooks.results(result.results);
          document.getElementById('search-count').textContent = result.total ? result.total + ' found' : 'No results';
          this.renderRows(document.getElementById('library'), result.results, result.total, true);
          this.renderRows(document.getElementById('search-results'), result.results, result.total, false);
        } catch (error) {
          if (error.name !== 'AbortError') {
            document.getElementById('search-count').textContent = 'Offline search · local cards';
            const query = (view.query || '').toLowerCase();
            const cards = this.state.items.filter(item => !item.trashedAt && (!query || [item.fileName, item.label, item.hidden ? '' : item.content].some(text => String(text || '').toLowerCase().includes(query))));
            this.renderRows(document.getElementById('library'), cards, cards.length, true);
          }
        }
      }, 100);
    }
    renderRows(container, cards, total, library) {
      const scrollTop = container.scrollTop;
      container.replaceChildren();
      if (library) {
        const summary = element('div', total + ' cards', 'library-summary');
        if (total > 100 || this.view().page) {
          const page = this.view().page || 0;
          const previous = button('Previous', () => this.hooks.view({ page: Math.max(0, page - 1), libraryAnchor: null })); previous.disabled = !page;
          const next = button('Next', () => this.hooks.view({ page: page + 1, libraryAnchor: null })); next.disabled = (page + 1) * 100 >= total;
          summary.append(previous, element('span', ' Page ' + (page + 1) + ' of ' + Math.max(1, Math.ceil(total / 100)) + ' '), next);
        }
        container.append(summary);
      }
      if (!cards.length) container.append(element('p', this.view().collection === 'trash' ? 'Trash is empty. Deleted cards can be restored here for 30 days.' : 'No cards match. Try another search or drop a file.', 'empty-results'));
      for (const card of cards) {
        const row = element('div', undefined, library ? 'library-row' : 'result-row'); row.dataset.id = card.id;
        const title = card.label || card.fileName || (card.hidden ? 'Hidden note' : card.content?.split('\n')[0]?.slice(0, 90)) || 'Untitled note';
        const info = element('div', undefined, 'row-info');
        info.append(card.trashedAt ? element('strong', title, 'row-title') : button(title, () => {
          if (this.state.workspaces.find(workspace => workspace.id === card.workspaceId)?.archived) this.hooks.command({ type: 'workspaceRestore', id: card.workspaceId });
          this.hooks.focus(card);
        }, 'row-title'));
        const date = new Date(card.createdAt || 0);
        const description = [card.workspaceName || this.state.workspaces.find(w => w.id === card.workspaceId)?.name, card.groupNames?.join(', '), card.mimeType || card.kind,
          Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '',
          card.fileSize !== undefined ? this.hooks.size(card.fileSize) : card.hidden ? 'Hidden content' : String(card.content || '').slice(0, 100)].filter(Boolean).join(' · ');
        info.append(element('div', description, 'row-meta'));
        row.append(info);
        if (library) {
          if (!card.trashedAt && card.workspaceId === this.state.workspaceId) {
            const select = element('input'); select.type = 'checkbox'; select.checked = this.view().selection?.includes(card.id); select.setAttribute('aria-label', 'Select ' + title);
            select.onchange = () => this.hooks.select(card.id); row.prepend(select);
          }
          const actions = element('div', undefined, 'row-actions');
          if (card.trashedAt) {
            actions.append(button('Restore', () => this.hooks.command({ type: 'restore', id: card.id, workspaceId: card.workspaceId, expectedVersion: card.version })));
            actions.append(button('Delete permanently', () => { if (confirm('Permanently delete this card and its unreferenced file?')) this.hooks.command({ type: 'purge', id: card.id, workspaceId: card.workspaceId, expectedVersion: card.version }); }, 'danger'));
          } else {
            if (card.kind !== 'text') actions.append(button('Download', () => this.hooks.download(card)));
            actions.append(button(card.archived ? 'Unarchive' : 'Archive', () => this.hooks.command({ type: 'archive', id: card.id, workspaceId: card.workspaceId, archived: !card.archived, expectedVersion: card.version })));
            actions.append(button('Trash', () => this.hooks.command({ type: 'delete', id: card.id, workspaceId: card.workspaceId, expectedVersion: card.version })));
          }
          row.append(actions);
        }
        container.append(row);
      }
      if (library) {
        if (Date.now() < (this.localScrollUntil || 0)) { this.scrollBlockedUntil = Date.now() + 60; container.scrollTop = scrollTop; }
        else this.applyScroll();
      }
    }
    applyScroll() {
      if (Date.now() < (this.localScrollUntil || 0)) return;
      const library = document.getElementById('library');
      if (library.hidden) return;
      const anchor = this.view().libraryAnchor;
      const row = anchor && [...library.querySelectorAll('.library-row')].find(row => row.dataset.id === anchor.id);
      if (anchor && !row) return;
      const position = row ? row.offsetTop + anchor.offset * row.offsetHeight : 0;
      if (Math.abs(library.scrollTop - position) > 2) {
        this.scrollBlockedUntil = Date.now() + 160;
        library.scrollTop = position;
      }
    }
    renderTransfers() {
      const list = document.getElementById('transfer-list'); list.replaceChildren();
      const jobs = this.hooks.transfers();
      if (!jobs.length) list.append(element('p', 'No active transfers. Queued uploads and downloads appear here.', 'empty-results'));
      for (const job of jobs) {
        const row = element('div', undefined, 'transfer-row');
        row.append(element('strong', job.name), element('div', job.message));
        if (job.cancel) row.append(button('Cancel', job.cancel));
        if (job.retry) row.append(button('Retry', job.retry));
        list.append(row);
      }
      const recovery = this.hooks.recovery();
      if (recovery) {
        const row = element('div', undefined, 'transfer-row conflict');
        row.append(element('strong', 'Recover local drafts'));
        const raw = element('textarea'); raw.readOnly = true; raw.value = recovery; raw.setAttribute('aria-label', 'Local draft recovery data'); row.append(raw);
        list.append(row);
      }
      for (const operation of this.hooks.conflicts()) {
        const row = element('div', undefined, 'transfer-row conflict');
        row.append(element('strong', 'Unsaved edit'), element('p', operation.error || 'This edit needs review.'));
        const draft = element('textarea'); draft.readOnly = true; draft.value = operation.message.content || operation.message.item?.content || JSON.stringify(operation.message); draft.setAttribute('aria-label', 'Recoverable edit'); row.append(draft);
        if (operation.current?.hidden || operation.message.item?.hidden) {
          draft.style.filter = 'blur(6px)';
          row.append(button('Reveal draft', () => { draft.style.filter = ''; }));
        }
        row.append(button('Keep my edit', () => this.hooks.retry(operation.operationId)), button('Keep server version', () => {
          if (confirm('Discard this queued edit? Copy the draft first if you need it.')) this.hooks.discard(operation.operationId);
        }));
        list.append(row);
      }
    }
  }
  window.RiftWorkspaceUI = WorkspaceUI;
})();
