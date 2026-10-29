const test = require('node:test');
const assert = require('node:assert');
const { tableRefs, caretContext, ident } = require('../src/completion');

test('table refs with aliases, schemas, quoting, comma lists and joins', () => {
  assert.deepStrictEqual(tableRefs(`select o.id from public.orders o
    left join "Customer Data" as c on c.id = o.cid, items i
    where x in (select 1 from [dbo].[lines] l)`), [
    { schema: 'public', table: 'orders', alias: 'o' },
    { schema: undefined, table: 'Customer Data', alias: 'c' },
    { schema: 'dbo', table: 'lines', alias: 'l' },
  ]);
  assert.deepStrictEqual(tableRefs('select * from a x, b, `c d` where 1'), [
    { schema: undefined, table: 'a', alias: 'x' },
    { schema: undefined, table: 'b', alias: undefined },
    { schema: undefined, table: 'c d', alias: undefined },
  ]);
  assert.deepStrictEqual(tableRefs('update t set a = 1'), [{ schema: undefined, table: 't', alias: undefined }]);
  assert.deepStrictEqual(tableRefs('insert into shop.dbo.t (a) values (1)'), [{ schema: 'dbo', table: 't', alias: undefined }]);
  assert.deepStrictEqual(tableRefs('select * from t\njoin u on u.id = t.id'), [
    { schema: undefined, table: 't', alias: undefined },
    { schema: undefined, table: 'u', alias: undefined },
  ]);
});

test('caret context', () => {
  assert.deepStrictEqual(caretContext('select o.'), { kind: 'qualified', qualifier: 'o', tablePosition: false });
  assert.deepStrictEqual(caretContext('select o.na'), { kind: 'qualified', qualifier: 'o', tablePosition: false });
  assert.deepStrictEqual(caretContext('select * from public.'), { kind: 'qualified', qualifier: 'public', tablePosition: true });
  assert.deepStrictEqual(caretContext('select * from "My Schema".or'), { kind: 'qualified', qualifier: 'My Schema', tablePosition: true });
  assert.deepStrictEqual(caretContext('select * from '), { kind: 'table' });
  assert.deepStrictEqual(caretContext('select * from ord'), { kind: 'table' });
  assert.deepStrictEqual(caretContext('select * from a x left join '), { kind: 'table' });
  assert.deepStrictEqual(caretContext('select * from a x, '), { kind: 'table' });
  assert.deepStrictEqual(caretContext('select '), { kind: 'any' });
  assert.deepStrictEqual(caretContext('select * from a where na'), { kind: 'any' });
  assert.deepStrictEqual(caretContext('select 1.5'), { kind: 'any' });
});

test('identifiers are quoted only when needed', () => {
  const dq = (s) => `"${s}"`;
  assert.strictEqual(ident('orders', 'postgres', dq), 'orders');
  assert.strictEqual(ident('Orders', 'postgres', dq), '"Orders"');
  assert.strictEqual(ident('Orders', 'mssql', dq), 'Orders');
  assert.strictEqual(ident('order', 'mysql', dq), '"order"');
  assert.strictEqual(ident('first name', 'sqlite', dq), '"first name"');
});
