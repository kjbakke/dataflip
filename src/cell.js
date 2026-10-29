// Driver value -> grid text (null stays null).
function cell(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return isNaN(v) ? String(v) : v.toISOString();
  if (v instanceof Uint8Array) {
    const hex = Buffer.from(v.subarray(0, 64)).toString('hex');
    return '0x' + hex.toUpperCase() + (v.length > 64 ? '…' : '');
  }
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'object' && typeof v.value === 'string') return v.value; // BigQuery INT64/DATE/TIMESTAMP wrappers
  if (typeof v === 'object') return JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && typeof x.value === 'string' ? x.value : x));
  return String(v);
}

module.exports = { cell };
