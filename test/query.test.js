const test = require('node:test');
const assert = require('node:assert');
const { tableQuery } = require('../src/query');

const pg = { quote: (s) => `"${s}"`, param: (i) => `$${i}`, limit: (sql, n) => `${sql} limit ${n}` };
const ms = { quote: (s) => `[${s}]`, param: (i) => `@p${i}`, limit: (sql, n) => sql.replace(/^select /i, `select top ${n} `) };

test('plain preview', () => {
  assert.deepStrictEqual(tableQuery(pg, { schema: 's', table: 't' }), { sql: 'select * from "s"."t" limit 500', params: [] });
  assert.deepStrictEqual(tableQuery(ms, { schema: 's', table: 't', orderBy: '[a] desc' }),
    { sql: 'select top 500 * from [s].[t] order by [a] desc', params: [] });
});

test('where, value filters with nulls, empty selection', () => {
  const q = tableQuery(pg, {
    schema: 's', table: 't', where: "x <> 'y'", orderBy: '"a" asc',
    filters: { a: { values: [1, 2], nulls: false }, b: { values: [], nulls: true }, c: { values: [], nulls: false } },
  });
  assert.strictEqual(q.sql, `select * from "s"."t" where (x <> 'y') and ("a" in ($1, $2)) and ("b" is null) and 1 = 0 order by "a" asc limit 500`);
  assert.deepStrictEqual(q.params, [1, 2]);
});

test('distinct list ignores its own column filter', () => {
  const q = tableQuery(ms, {
    schema: 's', table: 't', filters: { a: { values: ['x'], nulls: true }, b: { values: [5], nulls: false } },
  }, 'a');
  assert.strictEqual(q.sql, 'select top 1000 [a], count(*) from [s].[t] where ([b] in (@p1)) group by [a] order by [a]');
  assert.deepStrictEqual(q.params, [5]);
});
