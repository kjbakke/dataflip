const vscode = require('vscode');
const crypto = require('node:crypto');
const { DRIVERS } = require('./drivers');
const { statementAt } = require('./splitter');
const { ResultsView } = require('./results');

const SOURCES = 'dataflip.sources';
const BINDINGS = 'dataflip.bindings';
const secretKey = (id) => `dataflip.password.${id}`;

function activate(context) {
  const { globalState, workspaceState, secrets } = context;
  const connections = new Map(); // source id -> Promise<driver>
  const sourceNodes = new Map(); // source id -> tree node, reused so the node can be refreshed by identity
  const results = new ResultsView();

  const sources = () => globalState.get(SOURCES, []);
  const source = (id) => sources().find((s) => s.id === id);

  function connect(ds) {
    if (!connections.has(ds.id)) {
      const p = secrets.get(secretKey(ds.id)).then((pw) => DRIVERS[ds.driver].connect(ds, pw));
      connections.set(ds.id, p);
      p.then(() => tree.fire(sourceNodes.get(ds.id)), () => connections.delete(ds.id));
    }
    return connections.get(ds.id);
  }

  async function disconnect(ds) {
    const p = connections.get(ds.id);
    connections.delete(ds.id);
    if (p) await p.then((c) => c.close()).catch(() => {});
  }

  // ---- Data Sources tree: source > schema > tables/views > table > column

  const changed = new vscode.EventEmitter();
  const tree = { fire: (node) => changed.fire(node) };
  const icon = (id, color) => new vscode.ThemeIcon(id, color && new vscode.ThemeColor(color));
  const Collapsed = vscode.TreeItemCollapsibleState.Collapsed;

  const provider = {
    onDidChangeTreeData: changed.event,

    getTreeItem(n) {
      switch (n.kind) {
        case 'source': {
          const d = DRIVERS[n.ds.driver];
          const item = new vscode.TreeItem(n.ds.name, Collapsed);
          item.id = n.ds.id;
          item.contextValue = 'source';
          item.description = d.file ? n.ds.file : d.cloud ? `${d.label} · ${n.ds.project}` : `${d.label} · ${n.ds.host}:${n.ds.port}`;
          item.iconPath = icon('database', connections.has(n.ds.id) ? 'charts.green' : undefined);
          return item;
        }
        case 'schema': {
          const item = new vscode.TreeItem(n.schema, Collapsed);
          item.id = `${n.ds.id}/${n.schema}`;
          item.contextValue = 'schema';
          item.iconPath = icon('symbol-namespace');
          return item;
        }
        case 'folder': {
          const item = new vscode.TreeItem(n.view ? 'views' : 'tables', Collapsed);
          item.id = `${n.ds.id}/${n.schema}/${n.view ? 'views' : 'tables'}`;
          item.iconPath = icon('folder');
          item.description = String(n.items.length);
          return item;
        }
        case 'table': {
          const item = new vscode.TreeItem(n.name, Collapsed);
          item.id = `${n.ds.id}/${n.schema}/${n.view ? 'views' : 'tables'}/${n.name}`;
          item.contextValue = 'table';
          item.iconPath = icon(n.view ? 'eye' : 'table');
          return item;
        }
        case 'column': {
          const item = new vscode.TreeItem(n.col.name);
          item.id = `${n.ds.id}/${n.schema}/${n.table}/${n.col.name}`;
          item.contextValue = 'column';
          item.description = n.col.type + (n.col.nullable ? '' : ' not null');
          item.iconPath = n.col.pk ? icon('key', 'charts.yellow') : icon('symbol-field');
          return item;
        }
        default: {
          const item = new vscode.TreeItem(n.message);
          item.iconPath = icon('error', 'errorForeground');
          item.tooltip = n.message;
          return item;
        }
      }
    },

    async getChildren(n) {
      if (!n) {
        return sources().map((ds) => {
          const node = sourceNodes.get(ds.id) || { kind: 'source' };
          node.ds = ds;
          sourceNodes.set(ds.id, node);
          return node;
        });
      }
      try {
        const db = await connect(n.ds);
        switch (n.kind) {
          case 'source':
            return (await db.schemas()).map((schema) => ({ kind: 'schema', ds: n.ds, schema }));
          case 'schema': {
            const all = await db.tables(n.schema);
            return [false, true]
              .map((view) => ({ kind: 'folder', ds: n.ds, schema: n.schema, view, items: all.filter((t) => t.view === view) }))
              .filter((f) => f.items.length);
          }
          case 'folder':
            return n.items.map((t) => ({ kind: 'table', ds: n.ds, schema: n.schema, ...t }));
          case 'table':
            return (await db.columns(n.schema, n.name)).map((col) => ({ kind: 'column', ds: n.ds, schema: n.schema, table: n.name, col }));
        }
      } catch (err) {
        return [{ kind: 'error', message: err.message || String(err) }];
      }
      return [];
    },
  };

  // ---- console <-> data source binding, shown in the status bar

  const bindings = () => workspaceState.get(BINDINGS, {});
  const boundSource = (doc) => source(bindings()[doc.uri.toString()]);
  const bind = (doc, ds) => workspaceState.update(BINDINGS, { ...bindings(), [doc.uri.toString()]: ds.id });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'dataflip.attachSource';
  const updateStatus = () => {
    const doc = vscode.window.activeTextEditor?.document;
    if (doc?.languageId !== 'sql') return status.hide();
    const ds = boundSource(doc);
    status.text = `$(database) ${ds ? ds.name : 'No data source'}`;
    status.tooltip = 'Data source for this console (click to change)';
    status.show();
  };

  async function pickSource(placeHolder) {
    const all = sources();
    if (!all.length) {
      const add = await vscode.window.showInformationMessage('No data sources configured.', 'Add Data Source');
      return add && addSource();
    }
    const pick = await vscode.window.showQuickPick(
      all.map((ds) => ({ label: ds.name, description: DRIVERS[ds.driver].label, ds })),
      { placeHolder });
    return pick?.ds;
  }

  async function addSource() {
    const driver = await vscode.window.showQuickPick(
      Object.entries(DRIVERS).map(([id, d]) => ({ label: d.label, id })),
      { placeHolder: 'Database type' });
    if (!driver) return;
    const d = DRIVERS[driver.id];
    const ds = { id: crypto.randomUUID(), driver: driver.id };
    let password;
    const ask = (prompt, value, extra) => vscode.window.showInputBox({ prompt, value, ignoreFocusOut: true, ...extra });

    if (d.file) {
      const uri = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Use Database File' });
      if (!uri) return;
      ds.file = uri[0].fsPath;
      ds.name = uri[0].path.split('/').pop();
    } else if (d.cloud) {
      ds.project = await ask('GCP project ID', '', { validateInput: (v) => (v.trim() ? null : 'Project ID is required') });
      if (!ds.project) return;
      const auth = await vscode.window.showQuickPick(
        ['Application Default Credentials (gcloud auth application-default login)', 'Service account key file…'],
        { placeHolder: 'Authentication' });
      if (!auth) return;
      if (auth.startsWith('Service')) {
        const key = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { JSON: ['json'] }, openLabel: 'Use Key File' });
        if (!key) return;
        ds.keyFile = key[0].fsPath;
      }
      ds.location = await ask('Location (blank = auto, e.g. EU, US, europe-north1)', '');
      if (ds.location === undefined) return;
      ds.name = await ask('Name', ds.project);
      if (!ds.name) return;
    } else {
      ds.host = await ask('Host', 'localhost');
      if (ds.host === undefined) return;
      const port = await ask('Port', String(d.port), { validateInput: (v) => (/^\d+$/.test(v) ? null : 'Port must be a number') });
      if (port === undefined) return;
      ds.port = Number(port);
      ds.database = await ask('Database', d.database || '');
      if (ds.database === undefined) return;
      ds.user = await ask('User', d.user);
      if (ds.user === undefined) return;
      password = await ask('Password', '', { password: true });
      if (password === undefined) return;
      const ssl = await vscode.window.showQuickPick(['No SSL', 'SSL (skip certificate verification)'], { placeHolder: 'SSL' });
      if (!ssl) return;
      ds.ssl = ssl !== 'No SSL';
      ds.name = await ask('Name', `${ds.database || ds.host}@${ds.host}`);
      if (!ds.name) return;
    }

    // Test connection before saving, like Rider's "Test Connection"
    try {
      const conn = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Connecting to ${ds.name}…` },
        () => d.connect(ds, password));
      await conn.close();
    } catch (err) {
      const keep = await vscode.window.showErrorMessage(`Connection failed: ${err.message}`, { modal: true }, 'Save Anyway');
      if (!keep) return;
    }
    if (password) await secrets.store(secretKey(ds.id), password);
    await globalState.update(SOURCES, [...sources(), ds]);
    tree.fire();
    return ds;
  }

  async function execute() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const doc = editor.document;
    let ds = boundSource(doc);
    if (!ds) {
      ds = await pickSource('Choose a data source for this console');
      if (!ds) return;
      await bind(doc, ds);
      updateStatus();
    }
    const sel = editor.selection;
    let sql = doc.getText(sel).trim();
    if (!sql) {
      const stmt = statementAt(doc.getText(), doc.offsetAt(sel.active));
      if (!stmt) return;
      sql = stmt.text;
      // flash the statement that ran, as Rider does
      const range = new vscode.Range(doc.positionAt(stmt.start), doc.positionAt(stmt.end));
      editor.setDecorations(flash, [range]);
      setTimeout(() => editor.setDecorations(flash, []), 400);
    }
    await runAndShow(ds, sql, ds.name);
  }

  // sql may be a function of the connected driver, for identifier quoting
  async function runAndShow(ds, sql, title) {
    results.running(title);
    try {
      const db = await connect(ds);
      const t0 = Date.now();
      const res = await db.run(typeof sql === 'function' ? sql(db) : sql);
      results.result(title, res, Date.now() - t0);
    } catch (err) {
      results.error(title, err);
    }
  }

  const flash = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
  });

  const cmd = (id, fn) => vscode.commands.registerCommand(id, fn);

  context.subscriptions.push(
    changed,
    status,
    flash,
    vscode.window.createTreeView('dataflip.sources', { treeDataProvider: provider, showCollapseAll: true }),
    vscode.window.registerWebviewViewProvider('dataflip.results', results),
    vscode.window.onDidChangeActiveTextEditor(updateStatus),
    vscode.workspace.onDidOpenTextDocument(updateStatus),

    cmd('dataflip.addSource', addSource),
    cmd('dataflip.refresh', (n) => tree.fire(n)),
    cmd('dataflip.disconnect', async (n) => {
      await disconnect(n.ds);
      tree.fire();
    }),
    cmd('dataflip.removeSource', async (n) => {
      const ok = await vscode.window.showWarningMessage(`Remove data source "${n.ds.name}"?`, { modal: true }, 'Remove');
      if (!ok) return;
      await disconnect(n.ds);
      sourceNodes.delete(n.ds.id);
      await secrets.delete(secretKey(n.ds.id));
      await globalState.update(SOURCES, sources().filter((s) => s.id !== n.ds.id));
      tree.fire();
      updateStatus();
    }),
    cmd('dataflip.newConsole', async (n) => {
      const ds = n?.ds || (await pickSource('Open console for data source'));
      if (!ds) return;
      const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: '' });
      await bind(doc, ds);
      await vscode.window.showTextDocument(doc);
      updateStatus();
    }),
    cmd('dataflip.attachSource', async () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (!doc) return;
      const ds = await pickSource('Attach data source to this file');
      if (!ds) return;
      await bind(doc, ds);
      updateStatus();
    }),
    cmd('dataflip.openTable', (n) =>
      runAndShow(n.ds, (db) => db.preview(n.schema, n.name), `${n.schema}.${n.name}`)),
    cmd('dataflip.copyName', (n) =>
      vscode.env.clipboard.writeText(n.kind === 'column' ? n.col.name : n.kind === 'schema' ? n.schema : `${n.schema}.${n.name}`)),
    cmd('dataflip.execute', execute),
    { dispose: () => connections.forEach((p) => p.then((c) => c.close()).catch(() => {})) },
  );
  updateStatus();
}

module.exports = { activate, deactivate() {} };
