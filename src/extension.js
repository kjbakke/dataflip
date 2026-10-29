const vscode = require('vscode');
const crypto = require('node:crypto');
const { DRIVERS } = require('./drivers');
const { statementAt } = require('./splitter');
const { ResultsView } = require('./results');
const { buildChanges } = require('./dml');

const SOURCES = 'dataflip.sources';
const BINDINGS = 'dataflip.bindings';
const HISTORY = 'dataflip.history';
const HISTORY_MAX = 500;
const secretKey = (id) => `dataflip.password.${id}`;

function activate(context) {
  const { globalState, secrets } = context;
  // consoles are real files, one folder per data source: <globalStorage>/consoles/<source id>/<timestamp>.sql
  const consolesDir = vscode.Uri.joinPath(context.globalStorageUri, 'consoles');
  const connections = new Map(); // source id -> Promise<driver>
  const sourceNodes = new Map(); // source id -> tree node, reused so the node can be refreshed by identity
  const results = new ResultsView();

  const sources = () => globalState.get(SOURCES, []);
  const source = (id) => sources().find((s) => s.id === id);

  // One connection per data source and database; database undefined = the one configured on the source.
  const ownDb = (ds, database) => (database && database !== ds.database ? database : undefined);
  const connKeys = (ds) => [...connections.keys()].filter((k) => k.startsWith(ds.id + '/'));
  function connect(ds, database) {
    database = ownDb(ds, database);
    const key = `${ds.id}/${database ?? ''}`;
    if (!connections.has(key)) {
      const first = !connKeys(ds).length;
      const p = secrets.get(secretKey(ds.id)).then((pw) => DRIVERS[ds.driver].connect(database ? { ...ds, database } : ds, pw));
      connections.set(key, p);
      p.then(() => first && tree.fire(sourceNodes.get(ds.id)), () => connections.delete(key)); // first connection turns the icon green
    }
    return connections.get(key);
  }

  async function disconnect(ds) {
    await Promise.all(connKeys(ds).map((k) => {
      const p = connections.get(k);
      connections.delete(k);
      return p.then((c) => c.close()).catch(() => {});
    }));
  }

  // ---- Data Sources tree: source > [databases >] schema > tables/views > table > column

  const changed = new vscode.EventEmitter();
  const tree = { fire: (node) => changed.fire(node) };
  const icon = (id, color) => new vscode.ThemeIcon(id, color && new vscode.ThemeColor(color));
  const Collapsed = vscode.TreeItemCollapsibleState.Collapsed;
  const base = (n) => `${n.ds.id}/${n.database ?? ''}`;

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
          item.iconPath = icon('database', connKeys(n.ds).length ? 'charts.green' : undefined);
          return item;
        }
        case 'database': {
          const item = new vscode.TreeItem(n.database, Collapsed);
          item.id = `${base(n)}/database`;
          item.contextValue = 'database';
          item.description = n.database === n.ds.database ? 'default' : undefined;
          item.iconPath = icon('database');
          return item;
        }
        case 'schema': {
          const item = new vscode.TreeItem(n.schema, Collapsed);
          item.id = `${base(n)}/${n.schema}`;
          item.contextValue = 'schema';
          item.iconPath = icon('symbol-namespace');
          return item;
        }
        case 'folder': {
          const item = new vscode.TreeItem(n.view ? 'views' : 'tables', Collapsed);
          item.id = `${base(n)}/${n.schema}/${n.view ? 'views' : 'tables'}`;
          item.iconPath = icon('folder');
          item.description = String(n.items.length);
          return item;
        }
        case 'table': {
          const item = new vscode.TreeItem(n.name, Collapsed);
          item.id = `${base(n)}/${n.schema}/${n.view ? 'views' : 'tables'}/${n.name}`;
          item.contextValue = 'table';
          item.iconPath = icon(n.view ? 'eye' : 'table');
          return item;
        }
        case 'consoles': {
          const item = new vscode.TreeItem('consoles', vscode.TreeItemCollapsibleState.Collapsed);
          item.id = `${n.ds.id}/consoles`;
          item.iconPath = icon('terminal');
          item.description = String(n.files.length);
          return item;
        }
        case 'console': {
          const item = new vscode.TreeItem(n.uri.path.split('/').pop().replace(/\.sql$/, ''));
          item.id = n.uri.toString();
          item.contextValue = 'console';
          item.resourceUri = n.uri;
          item.iconPath = icon('file-code');
          item.command = { command: 'vscode.open', title: 'Open Console', arguments: [n.uri] };
          return item;
        }
        case 'column': {
          const item = new vscode.TreeItem(n.col.name);
          item.id = `${base(n)}/${n.schema}/${n.table}/${n.col.name}`;
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
        const db = await connect(n.ds, n.database);
        const { ds, database } = n;
        const schemas = async () => (await db.schemas()).map((schema) => ({ kind: 'schema', ds, database, schema }));
        switch (n.kind) {
          case 'source': {
            const below = db.databases
              ? (await db.databases()).map((name) => ({ kind: 'database', ds, database: name }))
              : await schemas();
            const files = await consoleFiles(ds);
            return files.length ? [{ kind: 'consoles', ds, files }, ...below] : below;
          }
          case 'database':
            return schemas();
          case 'consoles':
            return n.files.map((uri) => ({ kind: 'console', ds, uri }));
          case 'schema': {
            const all = await db.tables(n.schema);
            return [false, true]
              .map((view) => ({ kind: 'folder', ds, database, schema: n.schema, view, items: all.filter((t) => t.view === view) }))
              .filter((f) => f.items.length);
          }
          case 'folder':
            return n.items.map((t) => ({ kind: 'table', ds, database, schema: n.schema, ...t }));
          case 'table':
            return (await db.columns(n.schema, n.name)).map((col) => ({ kind: 'column', ds, database, schema: n.schema, table: n.name, col, parent: n }));
        }
      } catch (err) {
        return [{ kind: 'error', message: err.message || String(err) }];
      }
      return [];
    },
  };

  // ---- console <-> data source binding, shown in the status bar

  // file uri -> { source, database? }; console files also belong to the source whose folder they are in
  const bindings = () => globalState.get(BINDINGS, {});
  const consoleOwner = (uri) => uri.toString().startsWith(consolesDir.toString() + '/') && uri.path.split('/').slice(-2)[0];
  const binding = (doc) => {
    const b = bindings()[doc.uri.toString()];
    const ds = source(b?.source || consoleOwner(doc.uri));
    return ds && { ds, database: b?.source === ds.id ? b.database : undefined };
  };
  const bind = (uri, ds, database) =>
    globalState.update(BINDINGS, { ...bindings(), [uri.toString()]: { source: ds.id, database: ownDb(ds, database) } });
  const targetName = (ds, database) => ds.name + (ownDb(ds, database) ? ` / ${database}` : '');

  async function consoleFiles(ds) {
    const dir = vscode.Uri.joinPath(consolesDir, ds.id);
    const entries = await vscode.workspace.fs.readDirectory(dir).then((e) => e, () => []);
    return entries
      .filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.sql'))
      .map(([name]) => vscode.Uri.joinPath(dir, name))
      .sort((a, b) => b.path.localeCompare(a.path)); // timestamp names: newest first
  }

  async function newConsole(ds, database, content = '') {
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '.');
    const uri = vscode.Uri.joinPath(consolesDir, ds.id, `${stamp}.sql`);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content));
    await bind(uri, ds, database);
    await vscode.window.showTextDocument(uri);
    tree.fire(sourceNodes.get(ds.id));
    updateStatus();
  }

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'dataflip.attachSource';
  const updateStatus = () => {
    const doc = vscode.window.activeTextEditor?.document;
    if (doc?.languageId !== 'sql') return status.hide();
    const b = binding(doc);
    status.text = `$(database) ${b ? targetName(b.ds, b.database) : 'No data source'}`;
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

  // undefined = keep the source's configured database (also when the source has no database list)
  async function pickDatabase(ds) {
    const db = await connect(ds).catch(() => undefined);
    if (!db?.databases) return undefined;
    const names = await db.databases().catch(() => []);
    const pick = await vscode.window.showQuickPick(
      names.map((name) => ({ label: name, description: name === ds.database ? 'default' : undefined })),
      { placeHolder: `Database on ${ds.name}` });
    return pick?.label;
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
    let b = binding(doc);
    if (!b) {
      const ds = await pickSource('Choose a data source for this console');
      if (!ds) return;
      b = { ds, database: await pickDatabase(ds) };
      await bind(doc.uri, b.ds, b.database);
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
    await runAndShow(b.ds, b.database, sql);
  }

  async function runAndShow(ds, database, sql) {
    const title = targetName(ds, database);
    opened = undefined;
    results.running(title);
    const entry = { sql, source: ds.id, database: ownDb(ds, database), at: Date.now() };
    try {
      const db = await connect(ds, database);
      const t0 = Date.now();
      const res = await db.run(sql);
      entry.ms = Date.now() - t0;
      entry.rows = res.columns.length ? res.total ?? res.rows.length : undefined;
      entry.affected = res.affected;
      results.result(title, res, entry.ms);
    } catch (err) {
      entry.error = err.message || String(err);
      results.error(title, err);
    }
    await globalState.update(HISTORY, [entry, ...history()].slice(0, HISTORY_MAX));
    historyChanged.fire();
  }

  // ---- Open Table: filterable; editable when the driver has transactions and the table a primary key

  let opened; // { ds, database, schema, table, view, columns, rows, pk } behind the grid, cleared by any other result
  async function openTable(ds, database, schema, table, view, filter = {}) {
    const title = (ownDb(ds, database) ? `${database}.` : '') + `${schema}.${table}`;
    opened = undefined;
    results.running(title);
    try {
      const db = await connect(ds, database);
      const t0 = Date.now();
      const [res, cols] = await Promise.all([db.run(db.preview(schema, table, filter)), db.columns(schema, table)]);
      const pk = cols.filter((c) => c.pk).map((c) => c.name);
      const readOnly = !db.transaction ? `Read-only: editing ${DRIVERS[ds.driver].label} tables is not supported`
        : view ? 'Read-only: view'
        : !pk.length ? 'Read-only: table has no primary key'
        : undefined;
      opened = { ds, database, schema, table, view, columns: res.columns, rows: res.rows, pk };
      results.result(title, res, Date.now() - t0, { pk, quoted: res.columns.map(db.quote), ...filter, readOnly });
    } catch (err) {
      results.error(title, err);
    }
  }

  results.onAction = async (msg) => {
    if (!opened) return;
    const { ds, database, schema, table, view } = opened;
    const filter = { where: msg.where || undefined, orderBy: msg.orderBy || undefined };
    if (msg.type === 'submit') {
      try {
        const db = await connect(ds, database);
        const keyOf = (row) => Object.fromEntries(opened.pk.map((c) => [c, opened.rows[row][opened.columns.indexOf(c)]]));
        const { deletes, updates, inserts } = msg.changes;
        await db.transaction(buildChanges(db, schema, table, {
          deletes: deletes.map((row) => ({ key: keyOf(row) })),
          updates: updates.map(({ row, values }) => ({ key: keyOf(row), values })),
          inserts,
        }));
      } catch (err) {
        return results.submitError(err);
      }
    }
    await openTable(ds, database, schema, table, view, filter);
  };

  // ---- column DDL from the tree

  async function alterTable(tableNode, [sql, params]) {
    try {
      const db = await connect(tableNode.ds, tableNode.database);
      await db.run(sql, params);
    } catch (err) {
      return vscode.window.showErrorMessage(err.message || String(err));
    }
    tree.fire(tableNode);
    const same = (a, b) => ownDb(a.ds, a.database) === ownDb(b.ds, b.database);
    if (opened?.ds.id === tableNode.ds.id && same(opened, tableNode) && opened.schema === tableNode.schema && opened.table === tableNode.name) {
      openTable(opened.ds, opened.database, opened.schema, opened.table, opened.view);
    }
  }
  const askName = (prompt, value) => vscode.window.showInputBox({
    prompt, value, ignoreFocusOut: true, validateInput: (v) => (v.trim() ? null : 'Name is required'),
  });

  // ---- query history (console statements, newest first)

  const history = () => globalState.get(HISTORY, []);
  const historyChanged = new vscode.EventEmitter();
  const historyProvider = {
    onDidChangeTreeData: historyChanged.event,
    getChildren: () => history(),
    getTreeItem(h) {
      const item = new vscode.TreeItem(h.sql.replace(/\s+/g, ' ').slice(0, 100));
      const ds = source(h.source);
      const outcome = h.error ? 'failed' : h.rows !== undefined ? `${h.rows} rows` : `${h.affected ?? 0} affected`;
      item.description = `${ds ? targetName(ds, h.database) : 'removed source'} · ${new Date(h.at).toLocaleString()} · ${outcome}`;
      item.tooltip = new vscode.MarkdownString().appendCodeblock(h.sql, 'sql').appendText(h.error ? `\n${h.error}` : `\n${h.ms} ms`);
      item.iconPath = h.error ? icon('error', 'errorForeground') : icon('history');
      item.contextValue = 'history';
      item.command = { command: 'dataflip.history.open', title: 'Open in Console', arguments: [h] };
      return item;
    },
  };
  const historySource = (h) => source(h.source) || (vscode.window.showWarningMessage('That data source was removed.'), undefined);

  const flash = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
  });

  const cmd = (id, fn) => vscode.commands.registerCommand(id, fn);

  context.subscriptions.push(
    changed,
    status,
    flash,
    vscode.window.createTreeView('dataflip.sources', { treeDataProvider: provider, showCollapseAll: true }),
    historyChanged,
    vscode.window.createTreeView('dataflip.history', { treeDataProvider: historyProvider }),
    vscode.window.registerWebviewViewProvider('dataflip.results', results, { webviewOptions: { retainContextWhenHidden: true } }),
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
      if (n) return newConsole(n.ds, n.database);
      const ds = await pickSource('Open console for data source');
      if (ds) await newConsole(ds, await pickDatabase(ds));
    }),
    cmd('dataflip.deleteConsole', async (n) => {
      const ok = await vscode.window.showWarningMessage(`Delete console "${n.uri.path.split('/').pop()}"?`, { modal: true }, 'Delete');
      if (!ok) return;
      await vscode.workspace.fs.delete(n.uri, { useTrash: true });
      tree.fire(sourceNodes.get(n.ds.id));
    }),
    cmd('dataflip.attachSource', async () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (!doc) return;
      const ds = await pickSource('Attach data source to this file');
      if (!ds) return;
      await bind(doc.uri, ds, await pickDatabase(ds));
      updateStatus();
    }),
    cmd('dataflip.openTable', (n) => openTable(n.ds, n.database, n.schema, n.name, n.view)),
    cmd('dataflip.addColumn', async (n) => {
      const name = await askName(`New column in ${n.schema}.${n.name}`);
      if (!name) return;
      const type = await vscode.window.showInputBox({
        prompt: 'Type and options, e.g. varchar(100) not null default \'\'', ignoreFocusOut: true,
        validateInput: (v) => (v.trim() ? null : 'Type is required'),
      });
      if (type) await alterTable(n, (await connect(n.ds, n.database)).addColumn(n.schema, n.name, name.trim(), type.trim()));
    }),
    cmd('dataflip.renameColumn', async (n) => {
      const name = await askName(`Rename column ${n.col.name}`, n.col.name);
      if (name && name.trim() !== n.col.name) {
        await alterTable(n.parent, (await connect(n.ds, n.database)).renameColumn(n.schema, n.table, n.col.name, name.trim()));
      }
    }),
    cmd('dataflip.dropColumn', async (n) => {
      const ok = await vscode.window.showWarningMessage(
        `Drop column "${n.col.name}" from ${n.schema}.${n.table}? Its data is deleted permanently.`, { modal: true }, 'Drop Column');
      if (ok) await alterTable(n.parent, (await connect(n.ds, n.database)).dropColumn(n.schema, n.table, n.col.name));
    }),
    cmd('dataflip.history.open', async (h) => {
      const ds = historySource(h);
      if (ds) await newConsole(ds, h.database, h.sql);
    }),
    cmd('dataflip.history.rerun', (h) => {
      const ds = historySource(h);
      if (ds) return runAndShow(ds, h.database, h.sql);
    }),
    cmd('dataflip.history.copy', (h) => vscode.env.clipboard.writeText(h.sql)),
    cmd('dataflip.history.clear', async () => {
      const ok = await vscode.window.showWarningMessage('Clear query history?', { modal: true }, 'Clear');
      if (!ok) return;
      await globalState.update(HISTORY, []);
      historyChanged.fire();
    }),
    cmd('dataflip.copyName', (n) =>
      vscode.env.clipboard.writeText(
        n.kind === 'column' ? n.col.name : n.kind === 'schema' ? n.schema : n.kind === 'database' ? n.database : `${n.schema}.${n.name}`)),
    cmd('dataflip.execute', execute),
    { dispose: () => connections.forEach((p) => p.then((c) => c.close()).catch(() => {})) },
  );
  updateStatus();
  if (context.extensionMode === vscode.ExtensionMode.Test) return { context, provider };
}

module.exports = { activate, deactivate() {} };
