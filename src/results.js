const vscode = require('vscode');
const crypto = require('node:crypto');

// shortcut: renders at most this many rows, all rows are still fetched; add cursor paging if big results matter
const MAX_ROWS = 1000;

function cell(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return isNaN(v) ? String(v) : v.toISOString();
  if (v instanceof Uint8Array) {
    const hex = Buffer.from(v.subarray(0, 64)).toString('hex');
    return '0x' + hex.toUpperCase() + (v.length > 64 ? '…' : '');
  }
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'object' && typeof v.value === 'string') return v.value; // BigQuery INT64/DATE/TIMESTAMP wrappers
  if (typeof v === 'object') return JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && typeof x.value === 'string' ? x.value : x));
  return String(v);
}

class ResultsView {
  constructor() {
    this.view = undefined;
    this.pending = undefined;
    this.onAction = undefined; // (message from the grid) => void
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = html(crypto.randomBytes(16).toString('base64'));
    view.webview.onDidReceiveMessage((m) => {
      if (m === 'ready') return this.pending && view.webview.postMessage(this.pending);
      this.onAction?.(m);
    });
    view.onDidDispose(() => (this.view = undefined));
  }

  running(title) {
    this.post({ title, running: true });
  }

  error(title, err) {
    this.post({ title, error: err?.message || String(err) });
  }

  // table: { pk, quoted, where, orderBy, readOnly? } when the rows come from Open Table
  result(title, res, ms, table) {
    const shown = res.rows.slice(0, MAX_ROWS);
    this.post({
      title,
      ms,
      columns: res.columns,
      rows: shown.map((r) => r.map(cell)),
      total: res.total ?? res.rows.length,
      affected: res.affected,
      table,
    });
  }

  // tells the grid a submit failed without dropping its pending edits
  submitError(err) {
    this.view?.webview.postMessage({ submitError: err?.message || String(err) });
  }

  async post(msg) {
    this.pending = msg;
    if (this.view) {
      this.view.show(true);
      this.view.webview.postMessage(msg);
    } else {
      const editor = vscode.window.activeTextEditor;
      await vscode.commands.executeCommand('dataflip.results.focus');
      if (editor) vscode.window.showTextDocument(editor.document, editor.viewColumn); // keep caret in the console
    }
  }
}

function html(nonce) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { padding: 0; margin: 0; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); color: var(--vscode-foreground); }
  #top { position: sticky; top: 0; z-index: 2; background: var(--vscode-panel-background); border-bottom: 1px solid var(--vscode-panel-border); font-family: var(--vscode-font-family); font-size: 12px; }
  #bar, #tools { padding: 4px 8px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  #tools { border-top: 1px solid var(--vscode-panel-border); }
  #tools[hidden] { display: none; }
  .title { font-weight: 600; }
  .err { color: var(--vscode-errorForeground); white-space: pre-wrap; }
  .muted { color: var(--vscode-descriptionForeground); }
  .pending { color: var(--vscode-editorWarning-foreground); }
  label { display: flex; gap: 4px; align-items: center; color: var(--vscode-descriptionForeground); }
  input.filter { width: 220px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 2px 4px; font-family: var(--vscode-editor-font-family); }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 2px 8px; cursor: pointer; font-size: 12px; }
  button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:disabled { opacity: .5; cursor: default; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid var(--vscode-panel-border); padding: 2px 8px; white-space: nowrap; max-width: 480px; overflow: hidden; text-overflow: ellipsis; text-align: left; }
  th { position: sticky; top: var(--top-h, 25px); background: var(--vscode-editorGroupHeader-tabsBackground); font-weight: 600; }
  th.sortable { cursor: pointer; }
  td.num, th.num { color: var(--vscode-editorLineNumber-foreground); text-align: right; user-select: none; }
  td.null { color: var(--vscode-descriptionForeground); font-style: italic; }
  tr:hover td { background: var(--vscode-list-hoverBackground); }
  td.mod { background: var(--vscode-diffEditor-modifiedTextBackground, rgba(255, 200, 0, .2)); }
  tr.new td { background: var(--vscode-diffEditor-insertedTextBackground); }
  tr.del td { background: var(--vscode-diffEditor-removedTextBackground); text-decoration: line-through; }
  td.sel { outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; }
  td input { width: 100%; min-width: 80px; box-sizing: border-box; font: inherit; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: none; outline: none; padding: 0; }
</style></head>
<body>
<div id="top">
  <div id="bar"><span class="muted">Run a statement with Cmd/Ctrl+Enter in a SQL console.</span></div>
  <div id="tools" hidden>
    <label>WHERE <input class="filter" id="where" placeholder="e.g. status = 'open'"></label>
    <label>ORDER BY <input class="filter" id="orderBy" placeholder="e.g. created_at desc"></label>
    <button id="addRow" title="Add row">+ Row</button>
    <button id="delRow" title="Delete / restore selected row (Cmd/Ctrl+Backspace)">− Row</button>
    <button id="setNull" title="Set selected cell to NULL">NULL</button>
    <button id="revert" title="Discard pending changes">Revert</button>
    <button id="submit" class="primary" title="Write changes in one transaction (Cmd/Ctrl+Enter)">Submit</button>
    <button id="reload" title="Reload rows">⟳</button>
    <span id="ro" class="muted"></span>
  </div>
</div>
<div id="grid"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const bar = $('bar'), tools = $('tools'), grid = $('grid');
  const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
  const DEFAULT = undefined; // new-row cell left out of the INSERT so the column default applies

  let m = null;          // last result message
  let edits, deleted, inserted, sel, status;

  function reset() {
    edits = new Map();   // row -> Map(col -> value)
    deleted = new Set(); // row
    inserted = [];       // Map(col -> value) per new row
    sel = null;          // { r, c }, r >= m.rows.length addresses inserted rows
    status = null;
  }
  const editable = () => m?.table && !m.table.readOnly;
  const pendingCount = () => [...edits.keys()].filter((r) => !deleted.has(r)).length + deleted.size + inserted.length;
  const valueAt = (r, c) => {
    if (r >= m.rows.length) { const row = inserted[r - m.rows.length]; return row.has(c) ? row.get(c) : DEFAULT; }
    const e = edits.get(r);
    return e && e.has(c) ? e.get(c) : m.rows[r][c];
  };

  window.addEventListener('message', ({ data }) => {
    if ('submitError' in data) { status = { err: data.submitError }; return renderBar(); }
    m = data;
    reset();
    tools.hidden = !m.table;
    if (m.table) {
      $('where').value = m.table.where || '';
      $('orderBy').value = m.table.orderBy || '';
      $('ro').textContent = m.table.readOnly || '';
      for (const id of ['addRow', 'delRow', 'setNull', 'revert', 'submit']) $(id).disabled = !editable();
    }
    render();
  });

  function renderBar() {
    bar.replaceChildren(el('span', m.title, 'title'));
    if (m.running) return bar.append(el('span', 'Running…', 'muted'));
    if (m.error) return bar.append(el('span', m.error, 'err'));
    if (!m.columns.length) return bar.append(el('span', m.affected + ' row(s) affected in ' + m.ms + ' ms', 'muted'));
    const shown = m.rows.length < m.total ? m.rows.length + ' of ' + m.total : m.total;
    bar.append(el('span', shown + ' row(s) in ' + m.ms + ' ms', 'muted'));
    const n = m.table ? pendingCount() : 0;
    if (n) bar.append(el('span', '· ' + n + ' pending change(s)', 'pending'));
    if (status?.busy) bar.append(el('span', '· ' + status.busy, 'muted'));
    if (status?.err) bar.append(el('span', status.err, 'err'));
    if (m.table) $('submit').textContent = n ? 'Submit (' + n + ')' : 'Submit';
    document.body.style.setProperty('--top-h', $('top').offsetHeight + 'px');
  }

  function render() {
    renderBar();
    grid.replaceChildren();
    if (!m || m.running || m.error || !m.columns.length) return;

    const table = el('table');
    const head = el('tr');
    head.append(el('th', '', 'num'));
    m.columns.forEach((c, i) => {
      const pk = m.table?.pk.includes(c);
      const th = el('th', (pk ? '🔑 ' : '') + c + sortMark(i), m.table ? 'sortable' : '');
      th.dataset.c = i;
      head.append(th);
    });
    const thead = el('thead');
    thead.append(head);
    table.append(thead);

    const body = el('tbody');
    const total = m.rows.length + inserted.length;
    for (let r = 0; r < total; r++) {
      const isNew = r >= m.rows.length;
      const tr = el('tr', undefined, isNew ? 'new' : deleted.has(r) ? 'del' : '');
      tr.append(el('td', isNew ? '+' : String(r + 1), 'num'));
      m.columns.forEach((_, c) => {
        const v = valueAt(r, c);
        const td = v === DEFAULT ? el('td', '<default>', 'null') : v === null ? el('td', '<null>', 'null') : el('td', v);
        if (typeof v === 'string') td.title = v;
        if (!isNew && edits.get(r)?.has(c)) td.classList.add('mod');
        if (sel && sel.r === r && sel.c === c) td.classList.add('sel');
        td.dataset.r = r;
        td.dataset.c = c;
        tr.append(td);
      });
      body.append(tr);
    }
    table.append(body);
    grid.append(table);
  }

  // ORDER BY from header clicks: asc -> desc -> none
  function sortMark(c) {
    if (!m.table) return '';
    const q = m.table.quoted[c];
    const o = (m.table.orderBy || '').trim();
    return o === q + ' asc' ? ' ▲' : o === q + ' desc' ? ' ▼' : '';
  }
  function guardPending() {
    if (!pendingCount()) return true;
    status = { err: 'Submit or revert pending changes first.' };
    renderBar();
    return false;
  }
  function reload(where = $('where').value.trim(), orderBy = $('orderBy').value.trim()) {
    if (!guardPending()) return;
    vscode.postMessage({ type: 'reload', where, orderBy });
  }

  function setValue(r, c, v) {
    if (r >= m.rows.length) inserted[r - m.rows.length].set(c, v);
    else {
      const e = edits.get(r) || new Map();
      if (v === m.rows[r][c]) e.delete(c); else e.set(c, v);
      if (e.size) edits.set(r, e); else edits.delete(r);
    }
    status = null;
    render();
  }

  function startEdit(td) {
    const r = +td.dataset.r, c = +td.dataset.c;
    if (!editable() || deleted.has(r)) return;
    const v = valueAt(r, c);
    const input = el('input');
    input.value = typeof v === 'string' ? v : '';
    td.replaceChildren(input);
    td.classList.remove('null');
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      if (save) setValue(r, c, input.value); else render();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      e.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
  }

  function toggleDelete() {
    if (!editable() || !sel) return;
    if (sel.r >= m.rows.length) { inserted.splice(sel.r - m.rows.length, 1); sel = null; }
    else if (deleted.has(sel.r)) deleted.delete(sel.r);
    else deleted.add(sel.r);
    render();
  }

  function submit() {
    if (!editable() || !pendingCount()) return;
    const named = (map) => Object.fromEntries([...map].map(([c, v]) => [m.columns[c], v]));
    const changes = {
      deletes: [...deleted],
      updates: [...edits].filter(([r]) => !deleted.has(r)).map(([row, e]) => ({ row, values: named(e) })),
      inserts: inserted.map((row) => ({ values: named(row) })),
    };
    status = { busy: 'Submitting…' };
    renderBar();
    vscode.postMessage({ type: 'submit', changes, where: $('where').value.trim(), orderBy: $('orderBy').value.trim() });
  }

  grid.addEventListener('click', (e) => {
    const th = e.target.closest('th.sortable');
    if (th) {
      const q = m.table.quoted[+th.dataset.c];
      const o = ($('orderBy').value || '').trim();
      const next = o === q + ' asc' ? q + ' desc' : o === q + ' desc' ? '' : q + ' asc';
      return reload(undefined, next);
    }
    const td = e.target.closest('td:not(.num)');
    if (!td || td.querySelector('input')) return;
    sel = { r: +td.dataset.r, c: +td.dataset.c };
    render();
  });
  grid.addEventListener('dblclick', (e) => {
    const td = e.target.closest('td:not(.num)');
    if (td) startEdit(td);
  });

  $('where').addEventListener('keydown', (e) => e.key === 'Enter' && reload());
  $('orderBy').addEventListener('keydown', (e) => e.key === 'Enter' && reload());
  $('reload').addEventListener('click', () => reload());
  $('addRow').addEventListener('click', () => {
    inserted.push(new Map());
    sel = { r: m.rows.length + inserted.length - 1, c: 0 };
    render();
    grid.querySelector('tr.new:last-child')?.scrollIntoView({ block: 'nearest' });
  });
  $('delRow').addEventListener('click', toggleDelete);
  $('setNull').addEventListener('click', () => sel && editable() && !deleted.has(sel.r) && setValue(sel.r, sel.c, null));
  $('revert').addEventListener('click', () => { reset(); render(); });
  $('submit').addEventListener('click', submit);

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 'Enter') { e.preventDefault(); submit(); }
    else if (mod && e.key === 'Backspace') { e.preventDefault(); toggleDelete(); }
    else if ((e.key === 'Enter' || e.key === 'F2') && sel) {
      e.preventDefault();
      const td = grid.querySelector('td[data-r="' + sel.r + '"][data-c="' + sel.c + '"]');
      if (td) startEdit(td);
    }
  });

  // Cmd/Ctrl+C copies the selected cell
  document.addEventListener('copy', (e) => {
    if (!sel || String(getSelection()) || e.target.tagName === 'INPUT') return;
    const v = valueAt(sel.r, sel.c);
    e.clipboardData.setData('text/plain', typeof v === 'string' ? v : '');
    e.preventDefault();
  });

  vscode.postMessage('ready');
</script></body></html>`;
}

module.exports = { ResultsView };
