// Dialect-aware SQL helpers shared by the table and query views.

// Quote an identifier per dialect: MySQL/MariaDB use backticks, Postgres/SQLite use double quotes.
export function quoteIdent(dbType: string | undefined, name: string): string {
  if (dbType === "mysql") return `\`${name}\``;
  return `"${name}"`;
}

// Build a table reference. MySQL qualifies with the database (`db`.`table`); Postgres/SQLite
// connections already target the database, so the table is referenced unqualified.
export function tableRef(dbType: string | undefined, database: string, table: string): string {
  if (dbType === "mysql") return `${quoteIdent(dbType, database)}.${quoteIdent(dbType, table)}`;
  return quoteIdent(dbType, table);
}

// Render a JS value as a SQL literal.
export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  const str = typeof value === "object" ? JSON.stringify(value) : String(value);
  return `'${str.replace(/'/g, "''")}'`;
}

// Build UPDATE statements for a set of row edits.
// `edits`: Map keyed "rowIdx:col" -> new value. `rows`: the original row objects.
// `columns`: all column names (used to build a full-row WHERE match).
// `rowIds`: optional per-row physical identifier (PostgreSQL ctid). When present, the WHERE
// targets the row by ctid — reliable even on tables without a usable primary key.
export function buildUpdateStatements(
  dbType: string | undefined,
  database: string,
  table: string,
  columns: string[],
  rows: Record<string, unknown>[],
  edits: Map<string, unknown>,
  rowIds?: (string | null)[]
): string[] {
  const byRow = new Map<number, Record<string, unknown>>();
  edits.forEach((value, key) => {
    const [rowIdxStr, ...colParts] = key.split(":");
    const rowIdx = Number(rowIdxStr);
    const col = colParts.join(":");
    if (!byRow.has(rowIdx)) byRow.set(rowIdx, {});
    byRow.get(rowIdx)![col] = value;
  });

  const qi = (name: string) => quoteIdent(dbType, name);
  // MySQL supports `UPDATE ... LIMIT 1`; Postgres/SQLite do not. The full-row WHERE keeps it specific.
  const limitClause = dbType === "mysql" ? " LIMIT 1" : "";
  const sqls: string[] = [];
  byRow.forEach((changes, rowIdx) => {
    const original = rows[rowIdx];
    const setClauses = Object.entries(changes)
      .map(([col, val]) => `${qi(col)} = ${sqlLiteral(val)}`)
      .join(", ");
    const ctid = rowIds?.[rowIdx];
    if (ctid) {
      // Reliable single-row target via the physical row id (no LIMIT needed — ctid is unique).
      sqls.push(`UPDATE ${tableRef(dbType, database, table)} SET ${setClauses} WHERE ctid = ${sqlLiteral(ctid)}`);
      return;
    }
    const whereClauses = columns
      .map((col) => {
        const v = original[col];
        return v === null || v === undefined ? `${qi(col)} IS NULL` : `${qi(col)} = ${sqlLiteral(v)}`;
      })
      .join(" AND ");
    sqls.push(`UPDATE ${tableRef(dbType, database, table)} SET ${setClauses} WHERE ${whereClauses}${limitClause}`);
  });
  return sqls;
}

// Pretty-print a generated SQL statement onto multiple lines for readability. Operates only
// outside string literals so values containing words like AND/OR/SET aren't broken.
export function formatSql(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  const isWordChar = (c: string) => /[A-Za-z0-9_]/.test(c);
  while (i < n) {
    const ch = sql[i];
    // Preserve quoted strings / identifiers verbatim.
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (sql[j] === quote && sql[j + 1] === quote) { j += 2; continue; }
        if (sql[j] === quote) { j++; break; }
        j++;
      }
      out += sql.slice(i, j);
      i = j;
      continue;
    }
    // At a word boundary, check for a clause keyword and break before it.
    if (isWordChar(ch) && (i === 0 || !isWordChar(sql[i - 1]))) {
      let j = i + 1;
      while (j < n && isWordChar(sql[j])) j++;
      const word = sql.slice(i, j);
      const upper = word.toUpperCase();
      if (upper === "SET" || upper === "WHERE") {
        out = out.replace(/\s+$/, "") + "\n" + word;
      } else if (upper === "AND" || upper === "OR") {
        out = out.replace(/\s+$/, "") + "\n  " + word;
      } else {
        out += word;
      }
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// Alias used for the injected ctid column so it can be found and stripped from displayed results.
export const CTID_ALIAS = "__iceql_ctid__";

// Inject PostgreSQL's `ctid` as the first selected column so each result row carries a reliable
// physical identifier. Only call this for queries already known to be simple single-table SELECTs.
export function injectCtid(query: string): string {
  // Cast to text so the driver returns a plain string (the raw `tid` type may not decode).
  return query.replace(/\bselect\b/i, (kw) => `${kw} ctid::text AS "${CTID_ALIAS}",`);
}

// Detect whether a query is a simple single-table SELECT whose rows can be safely edited.
// Returns the lowercased table token (as written) or null if the query isn't editable.
// Conservative: rejects joins, aggregates, grouping, distinct, unions, and subqueries.
export function parseEditableTable(query: string): string | null {
  // Strip line and block comments, then collapse whitespace.
  const cleaned = query
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim()
    .replace(/;\s*$/, "");

  const lower = cleaned.toLowerCase();
  if (!lower.startsWith("select")) return null;
  // Reject anything that breaks the 1 row : 1 table-row mapping.
  if (/\b(join|group\s+by|distinct|union|having)\b/.test(lower)) return null;
  if (/\bselect\b[\s\S]*\bselect\b/.test(lower)) return null; // subquery

  // Capture the table after FROM, up to the next clause or end.
  const m = cleaned.match(/\bfrom\s+([^\s,;()]+)/i);
  if (!m) return null;
  // A comma before WHERE/end would mean multiple tables in the FROM — reject.
  const afterFrom = cleaned.slice(m.index! + m[0].length);
  if (/^\s*,/.test(afterFrom)) return null;

  // Strip surrounding quotes/backticks and any schema qualifier.
  let token = m[1];
  const parts = token.split(".");
  token = parts[parts.length - 1];
  token = token.replace(/^["`]|["`]$/g, "");
  return token.toLowerCase();
}
