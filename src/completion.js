// Lightweight SQL reading for autocomplete: which tables a statement uses and what the caret is asking for.
// Regex-based on purpose: it only has to be right for the statement being typed, not parse all of SQL.

const KEYWORDS = [
  'select', 'from', 'where', 'and', 'or', 'not', 'null', 'is', 'in', 'like', 'between', 'exists', 'as', 'distinct',
  'join', 'inner join', 'left join', 'right join', 'full join', 'cross join', 'on', 'using',
  'group by', 'order by', 'having', 'limit', 'offset', 'asc', 'desc', 'union', 'union all',
  'insert into', 'values', 'update', 'set', 'delete from', 'returning', 'with',
  'case', 'when', 'then', 'else', 'end', 'count', 'sum', 'avg', 'min', 'max', 'coalesce', 'cast',
  'create table', 'alter table', 'drop table', 'primary key', 'default', 'true', 'false',
];
const RESERVED = new Set(KEYWORDS.flatMap((k) => k.split(' ')).concat(['table', 'user', 'order', 'group', 'select']));
const NOT_ALIAS = new Set([
  'where', 'on', 'using', 'join', 'inner', 'left', 'right', 'full', 'outer', 'cross', 'natural', 'group', 'order',
  'having', 'limit', 'offset', 'set', 'values', 'union', 'select', 'returning', 'window', 'for', 'as',
]);

const IDENT = '(?:"(?:[^"]|"")+"|`(?:[^`]|``)+`|\\[(?:[^\\]]|\\]\\])+\\]|[A-Za-z_][\\w$]*)';
const unquote = (s) =>
  s[0] === '"' ? s.slice(1, -1).replace(/""/g, '"')
    : s[0] === '`' ? s.slice(1, -1).replace(/``/g, '`')
      : s[0] === '[' ? s.slice(1, -1).replace(/]]/g, ']')
        : s;
const nameParts = (s) => s.match(new RegExp(IDENT, 'g')).map(unquote);

// Tables after FROM / JOIN / UPDATE / INTO (and comma lists after FROM): [{ schema?, table, alias? }].
// db.schema.table keeps the last two parts.
function tableRefs(sql) {
  const refs = [];
  const one = new RegExp(`(${IDENT}(?:\\s*\\.\\s*${IDENT}){0,2})(?:\\s+(?:as\\s+)?(${IDENT}))?`, 'iy');
  const comma = /\s*,\s*/y;
  const kw = /\b(from|join|update|into)\s+/gi;
  let m;
  while ((m = kw.exec(sql))) {
    let pos = kw.lastIndex;
    for (;;) {
      one.lastIndex = pos;
      const r = one.exec(sql);
      if (!r) break;
      const parts = nameParts(r[1]);
      let alias = r[2] && unquote(r[2]);
      if (alias && NOT_ALIAS.has(alias.toLowerCase())) alias = undefined;
      refs.push({ schema: parts.length > 1 ? parts[parts.length - 2] : undefined, table: parts[parts.length - 1], alias });
      pos = r.index + (alias ? r[0].length : r[1].length);
      if (m[1].toLowerCase() !== 'from') break;
      comma.lastIndex = pos;
      if (!comma.exec(sql)) break;
      pos = comma.lastIndex;
    }
  }
  return refs;
}

const TABLE_KW = /\b(from|join|update|into|table)\s+$/i;

// What the caret is completing, from the text just before it:
//   { kind: 'qualified', qualifier, tablePosition }  after "x." (alias/table -> columns, schema -> tables)
//   { kind: 'table' }                                where a table name goes
//   { kind: 'any' }
function caretContext(before) {
  const q = new RegExp(`(${IDENT})\\s*\\.\\s*[\\w$]*$`).exec(before);
  if (q) return { kind: 'qualified', qualifier: unquote(q[1]), tablePosition: TABLE_KW.test(before.slice(0, q.index)) };
  const word = before.replace(/[\w$]*$/, '');
  if (TABLE_KW.test(word) || /\bfrom\s+[\w$."`[\]\s]*,\s*$/i.test(word)) return { kind: 'table' };
  return { kind: 'any' };
}

// Identifier as it should be typed: bare when the dialect would read it back unchanged, quoted otherwise.
function ident(name, driver, quote) {
  const plain = driver === 'postgres' ? /^[a-z_][a-z0-9_$]*$/ : /^[A-Za-z_][A-Za-z0-9_$]*$/;
  return plain.test(name) && !RESERVED.has(name.toLowerCase()) ? name : quote(name);
}

const same = (a, b) => a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

module.exports = { KEYWORDS, tableRefs, caretContext, ident, same };
