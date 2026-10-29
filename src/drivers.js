// Each driver exposes the same shape:
//   run(sql, params?) -> { columns: string[], rows: any[][], affected?: number }
//   schemas(), tables(schema), columns(schema, table), quote(ident), close()

const dq = (s) => `"${String(s).replace(/"/g, '""')}"`;
const bq = (s) => '`' + String(s).replace(/`/g, '``') + '`';

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

const DRIVERS = {
  postgres: { label: 'PostgreSQL', port: 5432, user: 'postgres', connect: postgres },
  mysql: { label: 'MySQL / MariaDB', port: 3306, user: 'root', connect: mysql },
  sqlite: { label: 'SQLite', file: true, connect: sqlite },
};

module.exports = { DRIVERS };
