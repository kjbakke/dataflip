const test = require('node:test');
const assert = require('node:assert');
const { splitStatements, statementAt } = require('../src/splitter');

test('splits on top-level semicolons only', () => {
  const sql = `select ';' as a; -- x; y
select "a;b" from t /* ; */;
do $$ begin perform 1; end $$;
select 'it''s;'`;
  assert.deepStrictEqual(splitStatements(sql).map((p) => p.text), [
    "select ';' as a",
    '-- x; y\nselect "a;b" from t /* ; */',
    'do $$ begin perform 1; end $$',
    "select 'it''s;'",
  ]);
});

test('picks statement under caret', () => {
  const sql = 'select 1;\n\nselect 2;\n';
  assert.strictEqual(statementAt(sql, 3).text, 'select 1');
  assert.strictEqual(statementAt(sql, 9).text, 'select 1'); // right after ;
  assert.strictEqual(statementAt(sql, 13).text, 'select 2');
  assert.strictEqual(statementAt(sql, sql.length).text, 'select 2');
  assert.strictEqual(statementAt('', 0), null);
});
