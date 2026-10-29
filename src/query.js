// SQL behind the table editor. where / orderBy are raw SQL typed by the user; column filters are
// Excel-style value lists, { [column]: { values: any[], nulls: boolean } }, always bound as params.
// With distinctOf set, returns that column's distinct values and counts under every other filter.
function tableQuery(db, { schema, table, where, orderBy, filters = {} }, distinctOf) {
  const params = [];
  const bind = (v) => (params.push(v), db.param(params.length));
  const conds = where ? [`(${where})`] : [];
  for (const [col, { values, nulls }] of Object.entries(filters)) {
    if (col === distinctOf) continue;
    const q = db.quote(col);
    const parts = [];
    if (values.length) parts.push(`${q} in (${values.map(bind).join(', ')})`);
    if (nulls) parts.push(`${q} is null`);
    conds.push(parts.length ? `(${parts.join(' or ')})` : '1 = 0');
  }
  const from = `${db.quote(schema)}.${db.quote(table)}` + (conds.length ? ` where ${conds.join(' and ')}` : '');

  if (distinctOf !== undefined) {
    const q = db.quote(distinctOf);
    return { sql: db.limit(`select ${q}, count(*) from ${from} group by ${q} order by ${q}`, DISTINCT_MAX), params };
  }
  return { sql: db.limit(`select * from ${from}` + (orderBy ? ` order by ${orderBy}` : ''), 500), params };
}

const DISTINCT_MAX = 1000;

module.exports = { tableQuery, DISTINCT_MAX };
