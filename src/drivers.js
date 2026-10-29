// Each driver exposes the same shape:
//   run(sql, params?) -> { columns: string[], rows: any[][], affected?: number, total?: number }
//   schemas(), tables(schema), columns(schema, table), quote(ident), preview(schema, table), close()

const dq = (s) => `"${String(s).replace(/"/g, '""')}"`;
const bq = (s) => '`' + String(s).replace(/`/g, '``') + '`';
const sq = (s) => `[${String(s).replace(/]/g, ']]')}]`;
const limit500 = (quote) => (schema, table) => `select * from ${quote(schema)}.${quote(table)} limit 500`;

async function postgres(cfg, password) {
  const { Client } = require('pg');
  const client = new Client({
    host: cfg.host, port: cfg.port, database: cfg.database, user: cfg.user, password,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  const run = async (sql, params) => {
    let res = await client.query({ text: sql, values: params, rowMode: 'array' });
    if (Array.isArray(res)) res = res[res.length - 1]; // multi-statement text: show the last result
    return res.fields?.length
      ? { columns: res.fields.map((f) => f.name), rows: res.rows }
      : { columns: [], rows: [], affected: res.rowCount ?? 0 };
  };
  return {
    run,
    quote: dq,
    preview: limit500(dq),
    close: () => client.end(),
    schemas: async () => (await run(
      `select schema_name from information_schema.schemata
       where schema_name not in ('information_schema', 'pg_catalog')
         and schema_name not like 'pg\\_toast%' and schema_name not like 'pg\\_temp%'
       order by 1`)).rows.map((r) => r[0]),
    tables: async (schema) => (await run(
      `select table_name, table_type from information_schema.tables where table_schema = $1 order by 1`,
      [schema])).rows.map(([name, type]) => ({ name, view: type === 'VIEW' })),
    columns: async (schema, table) => (await run(
      `select c.column_name, c.data_type, c.is_nullable = 'YES',
              exists (select 1 from information_schema.table_constraints tc
                      join information_schema.key_column_usage k
                        on k.constraint_name = tc.constraint_name and k.table_schema = tc.table_schema
                      where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = c.table_schema
                        and tc.table_name = c.table_name and k.column_name = c.column_name)
       from information_schema.columns c
       where c.table_schema = $1 and c.table_name = $2 order by c.ordinal_position`,
      [schema, table])).rows.map(([name, type, nullable, pk]) => ({ name, type, nullable, pk })),
  };
}

async function mysql(cfg, password) {
  const mysql2 = require('mysql2/promise');
  const conn = await mysql2.createConnection({
    host: cfg.host, port: cfg.port, database: cfg.database || undefined, user: cfg.user, password,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
  });
  const run = async (sql, params) => {
    const [rows, fields] = await conn.query({ sql, values: params, rowsAsArray: true });
    return fields
      ? { columns: fields.map((f) => f.name), rows }
      : { columns: [], rows: [], affected: rows.affectedRows ?? 0 };
  };
  return {
    run,
    quote: bq,
    preview: limit500(bq),
    close: () => conn.end(),
    schemas: async () => (await run(
      `select schema_name from information_schema.schemata
       where schema_name not in ('information_schema', 'mysql', 'performance_schema', 'sys') order by 1`
    )).rows.map((r) => r[0]),
    tables: async (schema) => (await run(
      `select table_name, table_type from information_schema.tables where table_schema = ? order by 1`,
      [schema])).rows.map(([name, type]) => ({ name, view: type === 'VIEW' })),
    columns: async (schema, table) => (await run(
      `select column_name, column_type, is_nullable = 'YES', column_key = 'PRI'
       from information_schema.columns where table_schema = ? and table_name = ? order by ordinal_position`,
      [schema, table])).rows.map(([name, type, nullable, pk]) => ({ name, type, nullable: !!nullable, pk: !!pk })),
  };
}

async function sqlite(cfg) {
  const { DatabaseSync } = require('node:sqlite'); // bundled with VS Code's Node 22.13+
  const db = new DatabaseSync(cfg.file);
  const run = async (sql, params = []) => {
    const stmt = db.prepare(sql);
    const columns = stmt.columns().map((c) => c.name);
    if (!columns.length) return { columns, rows: [], affected: Number(stmt.run(...params).changes) };
    stmt.setReturnArrays(true);
    return { columns, rows: stmt.all(...params) };
  };
  return {
    run,
    quote: dq,
    preview: limit500(dq),
    close: async () => db.close(),
    schemas: async () => ['main'],
    tables: async () => (await run(
      `select name, type from sqlite_master where type in ('table', 'view') and name not like 'sqlite\\_%' escape '\\' order by 1`
    )).rows.map(([name, type]) => ({ name, view: type === 'view' })),
    columns: async (_schema, table) => (await run(
      'select name, type, "notnull", pk from pragma_table_info(?)', [table]
    )).rows.map(([name, type, notnull, pk]) => ({ name, type: type || 'any', nullable: !notnull, pk: pk > 0 })),
  };
}

async function mssql(cfg, password) {
  const sql = require('mssql');
  const pool = await new sql.ConnectionPool({
    server: cfg.host, port: cfg.port, database: cfg.database || undefined, user: cfg.user, password,
    options: { encrypt: !!cfg.ssl, trustServerCertificate: true },
  }).connect();
  // params bind as @p1, @p2, ...
  const run = async (text, params = []) => {
    const req = pool.request();
    req.arrayRowMode = true;
    params.forEach((v, i) => req.input(`p${i + 1}`, v));
    const res = await req.query(text);
    const cols = res.columns?.[res.columns.length - 1]; // batch with several selects: show the last
    return cols
      ? { columns: cols.map((c) => c.name), rows: res.recordsets[res.recordsets.length - 1] }
      : { columns: [], rows: [], affected: res.rowsAffected.reduce((a, b) => a + b, 0) };
  };
  return {
    run,
    quote: sq,
    preview: (schema, table) => `select top 500 * from ${sq(schema)}.${sq(table)}`,
    close: () => pool.close(),
    // schema_id >= 16384 are the fixed db_* role schemas
    schemas: async () => (await run(
      `select name from sys.schemas where schema_id < 16384 and name not in ('sys', 'INFORMATION_SCHEMA', 'guest') order by 1`
    )).rows.map((r) => r[0]),
    tables: async (schema) => (await run(
      `select table_name, table_type from information_schema.tables where table_schema = @p1 order by 1`,
      [schema])).rows.map(([name, type]) => ({ name, view: type === 'VIEW' })),
    columns: async (schema, table) => (await run(
      `select c.column_name, c.data_type, case when c.is_nullable = 'YES' then 1 else 0 end,
              case when exists (select 1 from information_schema.table_constraints tc
                      join information_schema.key_column_usage k
                        on k.constraint_name = tc.constraint_name and k.table_schema = tc.table_schema
                      where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = c.table_schema
                        and tc.table_name = c.table_name and k.column_name = c.column_name) then 1 else 0 end
       from information_schema.columns c
       where c.table_schema = @p1 and c.table_name = @p2 order by c.ordinal_position`,
      [schema, table])).rows.map(([name, type, nullable, pk]) => ({ name, type, nullable: !!nullable, pk: !!pk })),
  };
}

// Schemas are datasets. Auth: service account key file if given, else Application Default Credentials.
async function bigquery(cfg) {
  const { BigQuery } = require('@google-cloud/bigquery');
  const client = new BigQuery({
    projectId: cfg.project,
    keyFilename: cfg.keyFile || undefined,
    location: cfg.location || undefined,
    apiEndpoint: cfg.apiEndpoint, // emulator only
  });
  const bqq = (s) => '`' + String(s).replace(/`/g, '\\`') + '`';
  const run = async (query, params) => {
    const [job] = await client.createQueryJob({ query, params });
    // fetch one page only: BigQuery results can be huge and the grid shows 1000 rows anyway
    const [rows, , res] = await job.getQueryResults({ autoPaginate: false, maxResults: 1000, wrapIntegers: true });
    const fields = res.schema?.fields || [];
    if (!fields.length) return { columns: [], rows: [], affected: Number(res.numDmlAffectedRows ?? 0) };
    return {
      columns: fields.map((f) => f.name),
      rows: rows.map((r) => fields.map((f) => r[f.name])),
      total: Number(res.totalRows ?? rows.length),
    };
  };
  return {
    run,
    quote: bqq,
    preview: (schema, table) => `select * from ${bqq(schema)}.${bqq(table)} limit 500`,
    close: async () => {},
    schemas: async () => (await client.getDatasets())[0].map((d) => d.id).sort(),
    tables: async (schema) => (await client.dataset(schema).getTables())[0]
      .map((t) => ({ name: t.id, view: /VIEW/.test(t.metadata?.type || '') }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    columns: async (schema, table) => {
      const [meta] = await client.dataset(schema).table(table).getMetadata();
      const pk = new Set(meta.tableConstraints?.primaryKey?.columns || []);
      return (meta.schema?.fields || []).map((f) => ({
        name: f.name,
        type: f.mode === 'REPEATED' ? `ARRAY<${f.type}>` : f.type,
        nullable: f.mode !== 'REQUIRED',
        pk: pk.has(f.name),
      }));
    },
  };
}

const DRIVERS = {
  postgres: { label: 'PostgreSQL', port: 5432, user: 'postgres', database: 'postgres', connect: postgres },
  mysql: { label: 'MySQL / MariaDB', port: 3306, user: 'root', connect: mysql },
  mssql: { label: 'SQL Server', port: 1433, user: 'sa', database: 'master', connect: mssql },
  sqlite: { label: 'SQLite', file: true, connect: sqlite },
  bigquery: { label: 'BigQuery', cloud: true, connect: bigquery },
};

module.exports = { DRIVERS };
