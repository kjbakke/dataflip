const test = require('node:test');
const assert = require('node:assert');
const { buildChanges } = require('../src/dml');

const pg = { quote: (s) => `"${s}"`, param: (i) => `$${i}` };

test('orders deletes, updates, inserts and binds params', () => {
  const stmts = buildChanges(pg, 'public', 't', {
    inserts: [{ values: { id: '3', name: null } }],
    updates: [{ key: { id: 1 }, values: { name: 'x', note: null } }, { key: { id: 9 }, values: {} }],
    deletes: [{ key: { a: 1, b: 2 } }],
  });
  assert.deepStrictEqual(stmts, [
    { sql: 'delete from "public"."t" where "a" = $1 and "b" = $2', params: [1, 2], expectOne: true },
    { sql: 'update "public"."t" set "name" = $1, "note" = $2 where "id" = $3', params: ['x', null, 1], expectOne: true },
    { sql: 'insert into "public"."t" ("id", "name") values ($1, $2)', params: ['3', null], expectOne: false },
  ]);
});

test('refuses keyless updates and empty inserts', () => {
  assert.throws(() => buildChanges(pg, 's', 't', { updates: [{ key: {}, values: { a: 1 } }] }), /no primary key/);
  assert.throws(() => buildChanges(pg, 's', 't', { inserts: [{ values: {} }] }), /at least one value/);
});
