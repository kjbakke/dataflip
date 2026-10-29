// SQLite always runs. Postgres/MySQL run when DATAFLIP_PG / DATAFLIP_MYSQL hold JSON
// configs, e.g. DATAFLIP_PG='{"host":"127.0.0.1","port":5432,"user":"postgres","database":"postgres","password":"x"}'
const test = require('node:test');
const assert = require('node:assert');
const { DRIVERS } = require('../src/drivers');

const cases = [
  ['sqlite', { file: ':memory:' }, 'main'],
  ['postgres', process.env.DATAFLIP_PG && JSON.parse(process.env.DATAFLIP_PG), 'public'],
  ['mysql', process.env.DATAFLIP_MYSQL && JSON.parse(process.env.DATAFLIP_MYSQL), null],
];

for (const [driver, cfg, defaultSchema] of cases) {
  test(driver, { skip: !cfg && 'no config' }, async () => {
    const db = await DRIVERS[driver].connect(cfg, cfg.password);
    const schema = defaultSchema || cfg.database;
    const t = `${db.quote(schema)}.${db.quote('rider "test"')}`;
    try {
      await db.run(`drop table if exists ${t}`);
      const ddl = await db.run(`create table ${t} (id int not null primary key, name varchar(20) not null, note varchar(20))`);
      assert.deepStrictEqual(ddl.columns, []);
      assert.strictEqual((await db.run(`insert into ${t} values (1, 'a', null), (2, 'b', 'x')`)).affected, 2);

      const res = await db.run(`select id, name, note from ${t} order by id`);
      assert.deepStrictEqual(res.columns, ['id', 'name', 'note']);
      assert.deepStrictEqual(res.rows.map((r) => r.map((v) => (v === null ? null : String(v)))), [['1', 'a', null], ['2', 'b', 'x']]);

      assert.ok((await db.schemas()).includes(schema));
      assert.deepStrictEqual((await db.tables(schema)).find((x) => x.name === 'rider "test"'), { name: 'rider "test"', view: false });
      const cols = await db.columns(schema, 'rider "test"');
      assert.deepStrictEqual(cols.map((c) => [c.name, c.nullable, c.pk]), [['id', false, true], ['name', false, false], ['note', true, false]]);
    } finally {
      await db.run(`drop table if exists ${t}`);
      await db.close();
    }
  });
}
