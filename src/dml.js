// Turns pending grid edits into parameterised statements for one table.
// changes: { deletes: [{ key }], updates: [{ key, values }], inserts: [{ values }] }
// where key / values map column name -> value (null = SQL NULL).
// Deletes run first so a re-inserted key does not collide; updates and deletes must hit exactly one row.
function buildChanges(db, schema, table, changes) {
  const target = `${db.quote(schema)}.${db.quote(table)}`;
  const stmts = [];

  const statement = (parts, expectOne) => {
    const params = [];
    const bind = (v) => (params.push(v), db.param(params.length));
    stmts.push({ sql: parts(bind), params, expectOne });
  };
  const where = (key, bind) => {
    const cols = Object.keys(key);
    if (!cols.length) throw new Error(`${table} has no primary key; rows cannot be identified`);
    return cols.map((c) => `${db.quote(c)} = ${bind(key[c])}`).join(' and ');
  };

  for (const { key } of changes.deletes || []) {
    statement((bind) => `delete from ${target} where ${where(key, bind)}`, true);
  }
  for (const { key, values } of changes.updates || []) {
    const cols = Object.keys(values);
    if (!cols.length) continue;
    statement((bind) => {
      const set = cols.map((c) => `${db.quote(c)} = ${bind(values[c])}`).join(', ');
      return `update ${target} set ${set} where ${where(key, bind)}`;
    }, true);
  }
  for (const { values } of changes.inserts || []) {
    const cols = Object.keys(values);
    if (!cols.length) throw new Error('A new row needs at least one value');
    statement((bind) => {
      const vals = cols.map((c) => bind(values[c])).join(', ');
      return `insert into ${target} (${cols.map(db.quote).join(', ')}) values (${vals})`;
    }, false);
  }
  return stmts;
}

module.exports = { buildChanges };
