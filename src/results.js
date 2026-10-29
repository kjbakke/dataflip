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
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

class ResultsView {
  constructor() {
    this.view = undefined;
    this.pending = undefined;
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = html(crypto.randomBytes(16).toString('base64'));
    view.webview.onDidReceiveMessage((m) => m === 'ready' && this.pending && view.webview.postMessage(this.pending));
    view.onDidDispose(() => (this.view = undefined));
  }

  running(title) {
    this.post({ title, running: true });
  }

  error(title, err) {
    this.post({ title, error: err?.message || String(err) });
  }

  result(title, res, ms) {
    const shown = res.rows.slice(0, MAX_ROWS);
    this.post({
      title,
      ms,
      columns: res.columns,
      rows: shown.map((r) => r.map(cell)),
      total: res.rows.length,
      affected: res.affected,
    });
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
  #bar { position: sticky; top: 0; z-index: 2; padding: 4px 8px; background: var(--vscode-panel-background); border-bottom: 1px solid var(--vscode-panel-border); font-family: var(--vscode-font-family); font-size: 12px; }
  #bar .title { font-weight: 600; margin-right: 8px; }
  #bar .err { color: var(--vscode-errorForeground); white-space: pre-wrap; }
  #bar .muted { color: var(--vscode-descriptionForeground); }
  table { border-collapse: collapse; }
  th, td { border: 1px solid var(--vscode-panel-border); padding: 2px 8px; white-space: nowrap; max-width: 480px; overflow: hidden; text-overflow: ellipsis; text-align: left; }
  th { position: sticky; top: 25px; background: var(--vscode-editorGroupHeader-tabsBackground); font-weight: 600; }
  td.num, th.num { color: var(--vscode-editorLineNumber-foreground); text-align: right; user-select: none; }
  td.null { color: var(--vscode-descriptionForeground); font-style: italic; }
  tr:hover td { background: var(--vscode-list-hoverBackground); }
  td.sel { background: var(--vscode-list-activeSelectionBackground) !important; color: var(--vscode-list-activeSelectionForeground); }
</style></head>
<body><div id="bar"><span class="muted">Run a statement with Cmd/Ctrl+Enter in a SQL console.</span></div><div id="grid"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const bar = document.getElementById('bar');
  const grid = document.getElementById('grid');
  const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };

  window.addEventListener('message', ({ data: m }) => {
    bar.replaceChildren(el('span', m.title, 'title'));
    grid.replaceChildren();
    if (m.running) return bar.append(el('span', 'Running…', 'muted'));
    if (m.error) return bar.append(el('span', m.error, 'err'));
    if (!m.columns.length) return bar.append(el('span', m.affected + ' row(s) affected in ' + m.ms + ' ms', 'muted'));
    const shown = m.rows.length < m.total ? m.rows.length + ' of ' + m.total : m.total;
    bar.append(el('span', shown + ' row(s) in ' + m.ms + ' ms', 'muted'));

    const table = el('table');
    const head = el('tr');
    head.append(el('th', '', 'num'));
    m.columns.forEach((c) => head.append(el('th', c)));
    table.append(el('thead')).append(head);
    const body = el('tbody');
    m.rows.forEach((r, i) => {
      const tr = el('tr');
      tr.append(el('td', String(i + 1), 'num'));
      r.forEach((v) => {
        const td = v === null ? el('td', '<null>', 'null') : el('td', v);
        if (v !== null) td.title = v;
        tr.append(td);
      });
      body.append(tr);
    });
    table.append(body);
    grid.append(table);
  });

  // click selects a cell, Cmd/Ctrl+C copies it
  let selected;
  grid.addEventListener('click', (e) => {
    const td = e.target.closest('td:not(.num)');
    selected?.classList.remove('sel');
    selected = td;
    td?.classList.add('sel');
  });
  document.addEventListener('copy', (e) => {
    if (!selected || String(getSelection())) return;
    e.clipboardData.setData('text/plain', selected.classList.contains('null') ? '' : selected.textContent);
    e.preventDefault();
  });

  vscode.postMessage('ready');
</script></body></html>`;
}

module.exports = { ResultsView };
