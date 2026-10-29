const vscode = require('vscode');
const crypto = require('node:crypto');
const { DRIVERS } = require('./drivers');
const { statementAt } = require('./splitter');
const { KEYWORDS, tableRefs, caretContext, ident, same } = require('./completion');
const { GridTabs } = require('./results');
const { cell } = require('./cell');
const { tableQuery, DISTINCT_MAX } = require('./query');
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
  // Disconnect collapses a source and keeps it closed: background work (autocomplete) must not reopen it,
  // only an explicit action does (expanding it, running a query, opening a table).
  const disconnected = new Set();
  const collapseGen = new Map(); // source id -> bumped on Disconnect; a new tree id makes VS Code show it collapsed
  const tabs = new GridTabs(vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png'));

  const sources = () => globalState.get(SOURCES, []);
  const source = (id) => sources().find((s) => s.id === id);

  // One connection per data source and database; database undefined = the one configured on the source.
  const ownDb = (ds, database) => (database && database !== ds.database ? database : undefined);
  const connKeys = (ds) => [...connections.keys()].filter((k) => k.startsWith(ds.id + '/'));
  function connect(ds, database) {
    disconnected.delete(ds.id);
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
    forget(ds);
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
          item.id = `${n.ds.id}#${collapseGen.get(n.ds.id) ?? 0}`;
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

  // Asks for a data source's settings, pre-filled from `old` when editing.
  // Returns { ds, password } (password undefined = keep the saved one) or undefined when cancelled.
  async function sourceForm(driverId, old = {}) {
    const d = DRIVERS[driverId];
    const ds = { ...old, id: old.id || crypto.randomUUID(), driver: driverId };
    const editing = !!old.id;
    let password;
    const ask = (prompt, value, extra) => vscode.window.showInputBox({ prompt, value, ignoreFocusOut: true, ...extra });

    if (d.file) {
      const uri = await vscode.window.showOpenDialog({
        canSelectMany: false, openLabel: 'Use Database File', defaultUri: old.file && vscode.Uri.file(old.file),
      });
      if (!uri) return;
      ds.file = uri[0].fsPath;
      ds.name = await ask('Name', old.name || uri[0].path.split('/').pop());
      if (!ds.name) return;
    } else if (d.cloud) {
      ds.project = await ask('GCP project ID', old.project || '', { validateInput: (v) => (v.trim() ? null : 'Project ID is required') });
      if (!ds.project) return;
      const adc = 'Application Default Credentials (gcloud auth application-default login)';
      const keyFile = 'Service account key file…';
      const auth = await vscode.window.showQuickPick(old.keyFile ? [keyFile, adc] : [adc, keyFile], { placeHolder: 'Authentication' });
      if (!auth) return;
      if (auth === keyFile) {
        const key = await vscode.window.showOpenDialog({
          canSelectMany: false, filters: { JSON: ['json'] }, openLabel: 'Use Key File', defaultUri: old.keyFile && vscode.Uri.file(old.keyFile),
        });
        if (!key) return;
        ds.keyFile = key[0].fsPath;
      } else delete ds.keyFile;
      ds.location = await ask('Location (blank = auto, e.g. EU, US, europe-north1)', old.location || '');
      if (ds.location === undefined) return;
      ds.name = await ask('Name', old.name || ds.project);
      if (!ds.name) return;
    } else {
      ds.host = await ask('Host', old.host || 'localhost');
      if (ds.host === undefined) return;
      const port = await ask('Port', String(old.port || d.port), { validateInput: (v) => (/^\d+$/.test(v) ? null : 'Port must be a number') });
      if (port === undefined) return;
      ds.port = Number(port);
      ds.database = await ask('Database', old.database ?? d.database ?? '');
      if (ds.database === undefined) return;
      ds.user = await ask('User', old.user ?? d.user);
      if (ds.user === undefined) return;
      password = await ask('Password', '', { password: true, placeHolder: editing ? 'Leave empty to keep the saved password' : undefined });
      if (password === undefined) return;
      if (editing && !password) password = undefined;
      const noSsl = 'No SSL';
      const ssl = 'SSL (skip certificate verification)';
      const pick = await vscode.window.showQuickPick(old.ssl ? [ssl, noSsl] : [noSsl, ssl], { placeHolder: 'SSL' });
      if (!pick) return;
      ds.ssl = pick === ssl;
      ds.name = await ask('Name', old.name || `${ds.database || ds.host}@${ds.host}`);
      if (!ds.name) return;
    }
    return { ds, password };
  }

  // Test connection before saving, like Rider's "Test Connection"
  async function testConnection(ds, password) {
    try {
      const conn = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Connecting to ${ds.name}…` },
        () => DRIVERS[ds.driver].connect(ds, password));
      await conn.close();
      return true;
    } catch (err) {
      return !!(await vscode.window.showErrorMessage(`Connection failed: ${err.message}`, { modal: true }, 'Save Anyway'));
    }
  }

  async function addSource() {
    const driver = await vscode.window.showQuickPick(
      Object.entries(DRIVERS).map(([id, d]) => ({ label: d.label, id })),
      { placeHolder: 'Database type' });
    if (!driver) return;
    const form = await sourceForm(driver.id);
    if (!form || !(await testConnection(form.ds, form.password))) return;
    if (form.password) await secrets.store(secretKey(form.ds.id), form.password);
    await globalState.update(SOURCES, [...sources(), form.ds]);
    tree.fire();
    return form.ds;
  }

  // Same id afterwards, so consoles, history and file bindings stay attached.
  async function editSource(old) {
    const form = await sourceForm(old.driver, old);
    if (!form) return;
    const password = form.password ?? (await secrets.get(secretKey(old.id)));
    if (!(await testConnection(form.ds, password))) return;
    await disconnect(old);
    if (form.password) await secrets.store(secretKey(old.id), form.password);
    await globalState.update(SOURCES, sources().map((s) => (s.id === old.id ? form.ds : s)));
    tree.fire();
    updateStatus();
  }

  async function duplicateSource(old) {
    const copy = { ...old, id: crypto.randomUUID(), name: `${old.name} (copy)` };
    const password = await secrets.get(secretKey(old.id));
    if (password) await secrets.store(secretKey(copy.id), password);
    const all = sources();
    const at = all.findIndex((s) => s.id === old.id) + 1;
    await globalState.update(SOURCES, [...all.slice(0, at), copy, ...all.slice(at)]);
    tree.fire();
    return copy;
  }

  // ---- export / import: data sources, their consoles and query history in one JSON file
  // (backups, another machine, or moving between builds of the extension, which never share storage)

  const EXPORT_VERSION = 1;

  async function exportSources(target, withPasswords) {
    if (withPasswords === undefined) {
      const pick = await vscode.window.showQuickPick(
        [{ label: 'Without passwords', value: false }, { label: 'Include passwords', description: 'stored in plain text in the file', value: true }],
        { placeHolder: 'Export data sources' });
      if (!pick) return;
      withPasswords = pick.value;
    }
    target ??= await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(require('node:path').join(require('node:os').homedir(), 'dataflip-sources.json')),
      filters: { JSON: ['json'] },
    });
    if (!target) return;
    const all = sources();
    const passwords = {};
    if (withPasswords) {
      for (const ds of all) {
        const pw = await secrets.get(secretKey(ds.id));
        if (pw) passwords[ds.id] = pw;
      }
    }
    const consoles = [];
    for (const ds of all) {
      for (const uri of await consoleFiles(ds)) {
        consoles.push({ source: ds.id, name: uri.path.split('/').pop(), content: Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8') });
      }
    }
    const data = { dataflip: EXPORT_VERSION, sources: all, passwords, consoles, history: history() };
    await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(data, null, 2)));
    vscode.window.showInformationMessage(
      `Exported ${all.length} data source(s) to ${target.fsPath}` + (withPasswords ? '. The file contains passwords: keep it safe and delete it when done.' : '.'));
  }

  // Adds what is not here yet (matched by id); never overwrites an existing data source.
  async function importSources(file) {
    file ??= (await vscode.window.showOpenDialog({ canSelectMany: false, filters: { JSON: ['json'] }, openLabel: 'Import' }))?.[0];
    if (!file) return;
    let data;
    try {
      data = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8'));
    } catch {
      data = undefined;
    }
    if (data?.dataflip !== EXPORT_VERSION || !Array.isArray(data.sources)) {
      vscode.window.showErrorMessage('Not a DataFlip export file.'); // not awaited: the command ends while the message shows
      return;
    }
    const existing = new Set(sources().map((s) => s.id));
    const added = data.sources.filter((s) => typeof s?.id === 'string' && DRIVERS[s.driver] && typeof s.name === 'string' && !existing.has(s.id));
    for (const ds of added) {
      const pw = data.passwords?.[ds.id];
      if (typeof pw === 'string' && pw) await secrets.store(secretKey(ds.id), pw);
    }
    await globalState.update(SOURCES, [...sources(), ...added]);

    let consoles = 0;
    const known = new Set(sources().map((s) => s.id));
    for (const c of Array.isArray(data.consoles) ? data.consoles : []) {
      // plain file names only, so an edited file cannot write outside the consoles folder
      if (!known.has(c?.source) || !/^[^/\\]+\.sql$/.test(c.name) || c.name.startsWith('.') || typeof c.content !== 'string') continue;
      const uri = vscode.Uri.joinPath(consolesDir, c.source, c.name);
      if (await vscode.workspace.fs.stat(uri).then(() => true, () => false)) continue;
      await vscode.workspace.fs.writeFile(uri, Buffer.from(c.content));
      consoles++;
    }

    const seen = new Set(history().map((h) => `${h.at}\u0000${h.sql}`));
    const newHistory = (Array.isArray(data.history) ? data.history : [])
      .filter((h) => typeof h?.sql === 'string' && typeof h.at === 'number' && known.has(h.source) && !seen.has(`${h.at}\u0000${h.sql}`));
    await globalState.update(HISTORY, [...history(), ...newHistory].sort((a, b) => b.at - a.at).slice(0, HISTORY_MAX));

    tree.fire();
    historyChanged.fire();
    const skipped = data.sources.length - added.length;
    vscode.window.showInformationMessage(
      `Imported ${added.length} data source(s), ${consoles} console(s) and ${newHistory.length} history entr${newHistory.length === 1 ? 'y' : 'ies'}` +
      (skipped ? `; ${skipped} already here or invalid, skipped.` : '.'));
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
    await runAndShow(b.ds, b.database, sql, `console:${doc.uri}`);
  }

  // Runs SQL into the results tab `key` (one per console), shown beside the console.
  async function runAndShow(ds, database, sql, key) {
    const title = targetName(ds, database);
    const grid = tabs.open(key, sql.replace(/\s+/g, ' ').slice(0, 40), { beside: true });
    grid.state = grid.onAction = undefined;
    grid.running(title);
    const entry = { sql, source: ds.id, database: ownDb(ds, database), at: Date.now() };
    try {
      const db = await connect(ds, database);
      const t0 = Date.now();
      const res = await db.run(sql);
      entry.ms = Date.now() - t0;
      entry.rows = res.columns.length ? res.total ?? res.rows.length : undefined;
      entry.affected = res.affected;
      grid.result(title, res, entry.ms);
    } catch (err) {
      entry.error = err.message || String(err);
      grid.error(title, err);
    }
    await globalState.update(HISTORY, [entry, ...history()].slice(0, HISTORY_MAX));
    historyChanged.fire();
  }

  // ---- Open Table: a tab per table, filterable; editable when the driver has transactions and the table a primary key

  const tableKey = (ds, database, schema, table) => `table:${ds.id}/${ownDb(ds, database) ?? ''}/${schema}/${table}`;

  // grid.state = the table behind the tab:
  // { ds, database, schema, table, view, columns, rows, pk, filter: { where, orderBy }, filters, distinct }
  async function openTable(ds, database, schema, table, view, filter = {}, filters = {}) {
    const title = (ownDb(ds, database) ? `${database}.` : '') + `${schema}.${table}`;
    const grid = tabs.open(tableKey(ds, database, schema, table), title);
    grid.onAction = (msg) => tableAction(grid, msg);
    grid.state = undefined;
    grid.running(title);
    try {
      const db = await connect(ds, database);
      const t0 = Date.now();
      const { sql, params } = tableQuery(db, { schema, table, ...filter, filters });
      const [res, cols] = await Promise.all([db.run(sql, params), db.columns(schema, table)]);
      const pk = cols.filter((c) => c.pk).map((c) => c.name);
      const readOnly = !db.transaction ? `Read-only: editing ${DRIVERS[ds.driver].label} tables is not supported`
        : view ? 'Read-only: view'
        : !pk.length ? 'Read-only: table has no primary key'
        : undefined;
      grid.state = { ds, database, schema, table, view, columns: res.columns, rows: res.rows, pk, filter, filters };
      grid.result(title, res, Date.now() - t0, {
        pk, quoted: res.columns.map(db.quote), ...filter, filtered: Object.keys(filters), readOnly,
      });
    } catch (err) {
      grid.error(title, err);
    }
  }

  async function tableAction(grid, msg) {
    const o = grid.state;
    if (!o) return;
    const { ds, database, schema, table, view } = o;

    // Excel-style column filter: the value list comes from the database under every other filter
    if (msg.type === 'distinct') {
      try {
        const db = await connect(ds, database);
        const q = tableQuery(db, { schema, table, ...o.filter, filters: o.filters }, msg.col);
        const res = await db.run(q.sql, q.params);
        const chosen = o.filters[msg.col];
        const keys = chosen && new Set([...chosen.values.map(cell), ...(chosen.nulls ? [null] : [])]);
        o.distinct = { col: msg.col, raws: res.rows.map((r) => r[0]) };
        grid.notify({ distinct: {
          col: msg.col,
          truncated: res.rows.length >= DISTINCT_MAX,
          items: res.rows.map(([v, n]) => ({ label: cell(v), count: Number(cell(n)), checked: !keys || keys.has(cell(v)) })),
        } });
      } catch (err) {
        grid.notify({ distinct: { col: msg.col, error: err.message || String(err) } });
      }
      return;
    }

    const filter = { where: msg.where || undefined, orderBy: msg.orderBy || undefined };
    let filters = o.filters;
    if (msg.type === 'colFilter') {
      filters = { ...filters };
      if (msg.selected === null) delete filters[msg.col];
      else {
        if (o.distinct?.col !== msg.col) return;
        // raw values as the driver returned them, so dates and big numbers bind exactly
        const raws = msg.selected.map((i) => o.distinct.raws[i]);
        filters[msg.col] = { values: raws.filter((v) => v !== null), nulls: raws.includes(null) };
      }
    }
    if (msg.type === 'submit') {
      try {
        const db = await connect(ds, database);
        const keyOf = (row) => Object.fromEntries(o.pk.map((c) => [c, o.rows[row][o.columns.indexOf(c)]]));
        const { deletes, updates, inserts } = msg.changes;
        await db.transaction(buildChanges(db, schema, table, {
          deletes: deletes.map((row) => ({ key: keyOf(row) })),
          updates: updates.map(({ row, values }) => ({ key: keyOf(row), values })),
          inserts,
        }));
      } catch (err) {
        return grid.submitError(err);
      }
    }
    await openTable(ds, database, schema, table, view, filter, filters);
  }

  // ---- column DDL from the tree

  async function alterTable(tableNode, [sql, params]) {
    try {
      const db = await connect(tableNode.ds, tableNode.database);
      await db.run(sql, params);
    } catch (err) {
      return vscode.window.showErrorMessage(err.message || String(err));
    }
    forget(tableNode.ds);
    tree.fire(tableNode);
    const o = tabs.tabs.get(tableKey(tableNode.ds, tableNode.database, tableNode.schema, tableNode.name))?.state;
    if (o) openTable(o.ds, o.database, o.schema, o.table, o.view, o.filter, o.filters);
  }

  const askName = (prompt, value) => vscode.window.showInputBox({
    prompt, value, ignoreFocusOut: true, validateInput: (v) => (v.trim() ? null : 'Name is required'),
  });

  // ---- autocomplete in SQL consoles, from metadata cached per data source + database

  const meta = new Map(); // `${ds.id}/${database}` -> Map(lookup -> Promise)
  const forget = (ds) => [...meta.keys()].filter((k) => !ds || k.startsWith(ds.id + '/')).forEach((k) => meta.delete(k));
  function metaFor(ds, database) {
    const key = `${ds.id}/${ownDb(ds, database) ?? ''}`;
    if (!meta.has(key)) meta.set(key, new Map());
    const cache = meta.get(key);
    const memo = (k, load) => {
      if (!cache.has(k)) {
        const p = connect(ds, database).then(load);
        p.catch(() => cache.delete(k)); // failures are not cached: the next keystroke retries
        cache.set(k, p);
      }
      return cache.get(k);
    };
    return {
      schemas: () => memo('schemas', (db) => db.schemas()),
      current: () => memo('current', (db) => db.currentSchema()),
      tables: (schema) => memo(`t:${schema}`, (db) => db.tables(schema)),
      columns: (schema, table) => memo(`c:${schema}\u0000${table}`, (db) => db.columns(schema, table)),
    };
  }

  const Kind = vscode.CompletionItemKind;
  const completionItem = (label, kind, detail, insertText, rank) => {
    const item = new vscode.CompletionItem(label, kind);
    item.detail = detail;
    item.insertText = insertText;
    item.sortText = `${rank}${label.toLowerCase()}`; // columns, then tables, schemas, keywords
    return item;
  };
  const keywordItems = () => KEYWORDS.map((k) => completionItem(k.toUpperCase(), Kind.Keyword, undefined, undefined, 4));

  async function completions(doc, pos) {
    const b = binding(doc);
    if (!b || disconnected.has(b.ds.id)) return keywordItems();
    const { ds, database } = b;
    const m = metaFor(ds, database);
    const db = await connect(ds, database);
    const name = (n) => ident(n, ds.driver, db.quote);
    const text = doc.getText();
    const offset = doc.offsetAt(pos);
    const stmt = statementAt(text, offset);
    // statementAt hands back the previous statement when the caret sits after its semicolon
    const refs = stmt && !text.slice(stmt.end, offset).includes(';') ? tableRefs(stmt.text) : [];
    const current = await m.current();

    const schemaItems = async () => (await m.schemas()).map((s) => {
      const item = completionItem(s, Kind.Module, 'schema', name(s), 3);
      item.commitCharacters = ['.'];
      return item;
    });
    const tableItems = async (schema) => (await m.tables(schema)).map((t) =>
      completionItem(t.name, t.view ? Kind.Interface : Kind.Class, `${t.view ? 'view' : 'table'} · ${schema}`, name(t.name), 2));
    const currentTables = async () => (current ? tableItems(current) : []);
    // a reference as written -> real schema and table (case-insensitive, like unquoted SQL)
    const resolve = async (ref) => {
      const schema = ref.schema ? (await m.schemas()).find((x) => same(x, ref.schema)) : current;
      const t = schema && (await m.tables(schema)).find((x) => same(x.name, ref.table));
      return t && { schema, table: t.name };
    };
    const columnItems = async (ref, rank = 1) => {
      const r = await resolve(ref);
      return r ? (await m.columns(r.schema, r.table)).map((c) =>
        completionItem(c.name, Kind.Field, `${c.type}${c.pk ? ' · PK' : ''} · ${ref.alias || r.table}`, name(c.name), rank)) : [];
    };

    const ctx = caretContext(text.slice(Math.max(0, offset - 2000), offset));
    if (ctx.kind === 'qualified') {
      if (!ctx.tablePosition) {
        const ref = refs.find((r) => same(r.alias, ctx.qualifier)) || refs.find((r) => same(r.table, ctx.qualifier));
        if (ref) return columnItems(ref, 0);
      }
      const schema = (await m.schemas()).find((x) => same(x, ctx.qualifier));
      if (schema) return tableItems(schema);
      return ctx.tablePosition ? [] : columnItems({ table: ctx.qualifier }, 0);
    }
    if (ctx.kind === 'table') return [...(await currentTables()), ...(await schemaItems())];
    const columns = (await Promise.all(refs.map((r) => columnItems(r)))).flat();
    return [...columns, ...(await currentTables()), ...(await schemaItems()), ...keywordItems()];
  }

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
    vscode.languages.registerCompletionItemProvider('sql', {
      provideCompletionItems: (doc, pos) => completions(doc, pos).catch(() => keywordItems()),
    }, '.'),
    tabs,
    vscode.window.onDidChangeActiveTextEditor(updateStatus),
    vscode.workspace.onDidOpenTextDocument(updateStatus),

    cmd('dataflip.addSource', addSource),
    cmd('dataflip.editSource', (n) => editSource(n.ds)),
    cmd('dataflip.duplicateSource', (n) => duplicateSource(n.ds)),
    cmd('dataflip.refresh', (n) => {
      forget(n?.ds);
      tree.fire(n);
    }),
    cmd('dataflip.disconnect', async (n) => {
      await disconnect(n.ds);
      disconnected.add(n.ds.id);
      collapseGen.set(n.ds.id, (collapseGen.get(n.ds.id) ?? 0) + 1);
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
      if (ds) return runAndShow(ds, h.database, h.sql, `history:${h.source}/${h.database ?? ''}`);
    }),
    cmd('dataflip.history.copy', (h) => vscode.env.clipboard.writeText(h.sql)),
    cmd('dataflip.exportSources', exportSources),
    cmd('dataflip.importSources', importSources),
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
  if (context.extensionMode === vscode.ExtensionMode.Test) return { context, provider, tabs };
}

module.exports = { activate, deactivate() {} };
