// SQLite always runs. The others run when DATAFLIP_<ENGINE> holds a JSON config, e.g.
//   DATAFLIP_PG='{"host":"127.0.0.1","port":5432,"user":"postgres","database":"postgres","password":"x"}'
//   DATAFLIP_MSSQL='{"host":"127.0.0.1","port":1433,"user":"sa","database":"master","password":"x"}'
//   DATAFLIP_BIGQUERY='{"project":"test","dataset":"ds1","apiEndpoint":"http://127.0.0.1:9050"}'  (goccy/bigquery-emulator)
const test = require('node:test');
const assert = require('node:assert');
const { DRIVERS } = require('../src/drivers');
const { buildChanges } = require('../src/dml');
const { tableQuery } = require('../src/query');
const { cell } = require('../src/cell');

const env = (name) => process.env[name] && JSON.parse(process.env[name]);
const sqlDdl = (t) => `create table ${t} (id int not null primary key, name varchar(20) not null, note varchar(20), placed date)`;

const cases = [
  { driver: 'sqlite', cfg: { file: ':memory:' }, schema: 'main', table: 'df "test"', ddl: sqlDdl },
  { driver: 'postgres', cfg: env('DATAFLIP_PG'), schema: 'public', table: 'df "test"', ddl: sqlDdl },
  { driver: 'mysql', cfg: env('DATAFLIP_MYSQL'), table: 'df "test"', ddl: sqlDdl },
  { driver: 'mssql', cfg: env('DATAFLIP_MSSQL'), schema: 'dbo', table: 'df "test] x"', ddl: sqlDdl },
  {
    driver: 'bigquery',
    cfg: env('DATAFLIP_BIGQUERY'),
    table: 'df_test',
    ddl: (t) => `create table ${t} (id int64 not null, name string not null, note string, placed date)`,
    emulator: true, // goccy/bigquery-emulator drops NOT NULL / constraints from DDL and reports no DML row counts
  },
];

for (const c of cases) {
  test(c.driver, { skip: !c.cfg && 'no config' }, async () => {
    const db = await DRIVERS[c.driver].connect(c.cfg, c.cfg.password);
    const schema = c.schema || c.cfg.database || c.cfg.dataset;
    const t = `${db.quote(schema)}.${db.quote(c.table)}`;
    try {
      await db.run(`drop table if exists ${t}`);
      const ddl = await db.run(c.ddl(t));
      assert.deepStrictEqual(ddl.columns, []);
      const ins = await db.run(`insert into ${t} values (1, 'a', null, '2026-01-05'), (2, 'b', 'x', '2026-02-01')`);
      if (!c.emulator) assert.strictEqual(ins.affected, 2);

      const res = await db.run(`select id, name, note from ${t} order by id`);
      assert.deepStrictEqual(res.columns, ['id', 'name', 'note']);
      const flat = (v) => (v === null ? null : typeof v === 'object' && 'value' in v ? String(v.value) : String(v));
      assert.deepStrictEqual(res.rows.map((r) => r.map(flat)), [['1', 'a', null], ['2', 'b', 'x']]);
      const tq = (opts, distinctOf) => {
        const { sql, params } = tableQuery(db, { schema, table: c.table, ...opts }, distinctOf);
        return db.run(sql, params);
      };
      assert.strictEqual((await tq({})).rows.length, 2);
      const filtered = await tq({ where: `${db.quote('name')} <> 'a'`, orderBy: `${db.quote('id')} desc` });
      assert.deepStrictEqual(filtered.rows.map((r) => flat(r[0])), ['2']);
      // Excel-style value filter: raw values from the distinct list go back as params
      const distinct = await tq({}, 'note');
      const counts = Object.fromEntries(distinct.rows.map(([v, n]) => [flat(v), Number(flat(n))])); // NULL sorts first or last per engine
      assert.deepStrictEqual(counts, { null: 1, x: 1 });
      const byNull = await tq({ filters: { note: { values: [], nulls: true } } });
      assert.deepStrictEqual(byNull.rows.map((r) => flat(r[0])), ['1']);
      const ids = (await tq({}, 'id')).rows.map((r) => r[0]);
      const byValue = await tq({ filters: { id: { values: [ids[1]], nulls: false } } });
      assert.deepStrictEqual(byValue.rows.map((r) => flat(r[1])), ['b']);
      // dates: shown without a timezone shift, and the raw value filters back exactly
      const dates = (await tq({}, 'placed')).rows.map((r) => r[0]);
      const feb = dates.find((v) => cell(v).startsWith('2026-02-01'));
      assert.ok(feb !== undefined, `dates as shown: ${dates.map(cell)}`);
      assert.deepStrictEqual((await tq({ filters: { placed: { values: [feb], nulls: false } } })).rows.map((r) => flat(r[0])), ['2']);

      assert.ok((await db.schemas()).includes(schema));
      if (db.databases) assert.ok((await db.databases()).includes(c.cfg.database));
      assert.deepStrictEqual((await db.tables(schema)).find((x) => x.name === c.table), { name: c.table, view: false });
      const cols = await db.columns(schema, c.table);
      if (c.emulator) assert.deepStrictEqual(cols.map((col) => col.name), ['id', 'name', 'note', 'placed']);
      else assert.deepStrictEqual(cols.map((col) => [col.name, col.nullable, col.pk]), [
        ['id', false, true],
        ['name', false, false],
        ['note', true, false],
        ['placed', true, false],
      ]);

      // grid edits: one transaction, keyed by primary key
      if (db.transaction) {
        await db.transaction(buildChanges(db, schema, c.table, {
          deletes: [{ key: { id: 2 } }],
          updates: [{ key: { id: 1 }, values: { name: 'A', note: null } }],
          inserts: [{ values: { id: 3, name: 'c' } }],
        }));
        const after = await db.run(`select id, name, note from ${t} order by id`);
        assert.deepStrictEqual(after.rows.map((r) => r.map(flat)), [['1', 'A', null], ['3', 'c', null]]);

        // a key that matches nothing rolls back the whole batch
        await assert.rejects(db.transaction(buildChanges(db, schema, c.table, {
          updates: [{ key: { id: 1 }, values: { name: 'Z' } }, { key: { id: 99 }, values: { name: 'Z' } }],
        })), /Expected 1 row but 0 matched/);
        assert.strictEqual(flat((await db.run(`select name from ${t} where id = 1`)).rows[0][0]), 'A');
      }

      // column DDL (the emulator lacks RENAME COLUMN and does not update metadata after ALTER)
      if (!c.emulator) {
        const ddlRun = ([sql, params]) => db.run(sql, params);
        await ddlRun(db.addColumn(schema, c.table, 'extra col', 'varchar(10)'));
        await ddlRun(db.renameColumn(schema, c.table, 'extra col', 'renamed'));
        assert.deepStrictEqual((await db.columns(schema, c.table)).map((col) => col.name), ['id', 'name', 'note', 'placed', 'renamed']);
        await ddlRun(db.dropColumn(schema, c.table, 'renamed'));
        assert.deepStrictEqual((await db.columns(schema, c.table)).map((col) => col.name), ['id', 'name', 'note', 'placed']);
      }
    } finally {
      await db.run(`drop table if exists ${t}`);
      await db.close();
    }
  });
}
