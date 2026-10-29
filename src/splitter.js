// Splits SQL on top-level semicolons, skipping strings, quoted identifiers,
// comments and Postgres $tag$ blocks. Returns [{ start, end, text }].
function splitStatements(sql) {
  const parts = [];
  let start = 0;
  let i = 0;
  const push = (end) => {
    const raw = sql.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text) parts.push({ start: start + lead, end: start + lead + text.length, text });
  };
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl + 1;
    } else if (c === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2);
      i = close === -1 ? sql.length : close + 2;
    } else if (c === "'" || c === '"' || c === '`') {
      i++;
      while (i < sql.length) {
        if (sql[i] === c && sql[i + 1] === c) i += 2; // doubled quote escape
        else if (sql[i] === '\\' && c !== '"') i += 2; // MySQL backslash escape
        else if (sql[i] === c) break;
        else i++;
      }
      i++;
    } else if (c === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        i = close === -1 ? sql.length : close + tag[0].length;
      } else i++;
    } else if (c === ';') {
      push(i);
      start = ++i;
    } else i++;
  }
  push(sql.length);
  return parts;
}

// Statement under the caret; a caret in the gap after a statement picks the one before it.
function statementAt(sql, offset) {
  const parts = splitStatements(sql);
  let best = null;
  for (const p of parts) {
    if (p.start <= offset) best = p;
    if (offset <= p.end) break;
  }
  return best || parts[0] || null;
}

module.exports = { splitStatements, statementAt };
