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
  rowIds?: (string | null)[],
  primaryKeys?: string[]
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
      sqls.push(`UPDATE ${tableRef(dbType, database, table)} SET ${setClauses} WHERE ctid = ${sqlLiteral(ctid)}`);
      return;
    }
    // Use primary key columns for WHERE if available — more reliable than all-column match.
    // For MySQL tables without PK metadata, avoid strict `IS NULL` full-row matching because
    // driver/type conversions can surface default non-null DB values as null in the client row,
    // which causes false 0-row matches.
    const hasPrimaryKeys = Boolean(primaryKeys && primaryKeys.length > 0);
    const whereCols = hasPrimaryKeys ? primaryKeys! : columns;
    const whereClauses = whereCols
      .flatMap((col) => {
        const v = original[col];
        if (v === null || v === undefined) {
          return !hasPrimaryKeys && dbType === "mysql" ? [] : [`${qi(col)} IS NULL`];
        }
        return [`${qi(col)} = ${sqlLiteral(v)}`];
      })
      .join(" AND ");
    const where = whereClauses || "1=1";
    sqls.push(`UPDATE ${tableRef(dbType, database, table)} SET ${setClauses} WHERE ${where}${limitClause}`);
  });
  return sqls;
}

// Build INSERT statements for newly-added (not-yet-persisted) rows.
// `edits`: the same "rowIdx:col" -> value map editing uses — only columns the user actually
// filled in are included, so id/auto-increment/defaulted columns are left for the DB to fill.
// `newRowIndices`: which row indices in `rows` are pending inserts (vs. edits on existing rows).
export function buildInsertStatements(
  dbType: string | undefined,
  database: string,
  table: string,
  rows: Record<string, unknown>[],
  edits: Map<string, unknown>,
  newRowIndices: number[]
): string[] {
  const qi = (name: string) => quoteIdent(dbType, name);
  return newRowIndices.map((rowIdx) => {
    const prefix = `${rowIdx}:`;
    const fields: [string, unknown][] = [];
    edits.forEach((value, key) => {
      if (!key.startsWith(prefix)) return;
      fields.push([key.slice(prefix.length), value]);
    });
    if (fields.length === 0) {
      // A row added but left entirely blank — insert an all-default row.
      return dbType === "mysql"
        ? `INSERT INTO ${tableRef(dbType, database, table)} () VALUES ()`
        : `INSERT INTO ${tableRef(dbType, database, table)} DEFAULT VALUES`;
    }
    const colList = fields.map(([col]) => qi(col)).join(", ");
    const valList = fields.map(([, val]) => sqlLiteral(val)).join(", ");
    return `INSERT INTO ${tableRef(dbType, database, table)} (${colList}) VALUES (${valList})`;
  });
}

// Build DELETE statements for a set of selected row indices.
export function buildDeleteStatements(
  dbType: string | undefined,
  database: string,
  table: string,
  columns: string[],
  rows: Record<string, unknown>[],
  selectedIndices: number[],
  rowIds?: (string | null)[],
  primaryKeys?: string[]
): string[] {
  const qi = (name: string) => quoteIdent(dbType, name);
  const limitClause = dbType === "mysql" ? " LIMIT 1" : "";
  // Use primary key columns for WHERE if available — more reliable than all-column match.
  // Same MySQL fallback logic as UPDATE when PK metadata is unavailable.
  const hasPrimaryKeys = Boolean(primaryKeys && primaryKeys.length > 0);
  const whereCols = hasPrimaryKeys ? primaryKeys! : columns;
  return selectedIndices.map((rowIdx) => {
    const row = rows[rowIdx];
    const ctid = rowIds?.[rowIdx];
    if (ctid) {
      return `DELETE FROM ${tableRef(dbType, database, table)} WHERE ctid = ${sqlLiteral(ctid)}`;
    }
    const whereClauses = whereCols
      .flatMap((col) => {
        const v = row[col];
        if (v === null || v === undefined) {
          return !hasPrimaryKeys && dbType === "mysql" ? [] : [`${qi(col)} IS NULL`];
        }
        return [`${qi(col)} = ${sqlLiteral(v)}`];
      })
      .join(" AND ");
    const where = whereClauses || "1=1";
    return `DELETE FROM ${tableRef(dbType, database, table)} WHERE ${where}${limitClause}`;
  });
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

// Detect a bare `USE <database>;` statement (MySQL/MariaDB session database switch) and
// return the target database name, or null if the query isn't one. Used to keep the tab's
// database selector in sync after a successful `USE`, since the backend runs each query
// against whatever database the frontend tells it to and has no persistent session state.
export function parseUseDatabase(query: string): string | null {
  const cleaned = query
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim()
    .replace(/;\s*$/, "");
  const m = cleaned.match(/^use\s+([^\s;]+)$/i);
  if (!m) return null;
  return m[1].replace(/^[`"]|[`"]$/g, "");
}

// Safety net for the "Run" button: appends a LIMIT to a plain SELECT/CTE query that doesn't
// already have one, so accidentally running an unbounded query against a huge table doesn't
// pull back the entire result set. Best-effort, not a real parser — skips anything that isn't
// confidently a single top-level SELECT (a LIMIT keyword anywhere, even inside a subquery,
// is treated as "already handled" so we never risk emitting invalid double-LIMIT SQL).
export function maybeInjectLimit(query: string, limit: number): string {
  if (!limit || limit <= 0) return query;
  const cleaned = query
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim();
  const lower = cleaned.toLowerCase();
  if (!lower.startsWith("select") && !lower.startsWith("with")) return query;
  if (/\blimit\b/.test(lower)) return query;
  const trimmed = query.trim().replace(/;\s*$/, "");
  return `${trimmed} LIMIT ${limit}`;
}

// Wraps an arbitrary SELECT/WITH query to count its full, untruncated result set — used to show
// "N total" after the safety limit (or a manual page) only fetched part of it. Only called on a
// query already confirmed eligible for that limit (plain SELECT/WITH, no LIMIT of its own).
export function buildCountQuery(query: string): string {
  const trimmed = query.trim().replace(/;\s*$/, "");
  return `SELECT COUNT(*) AS __iceql_total__ FROM (${trimmed}) AS __iceql_count_sub__`;
}

// Pages through a query the safety limit (see maybeInjectLimit) truncated — only ever called on
// a query already confirmed eligible for that limit (plain SELECT/WITH, no existing LIMIT), so
// appending our own LIMIT/OFFSET here is always safe.
export function buildPagedQuery(query: string, limit: number, offset: number): string {
  const trimmed = query.trim().replace(/;\s*$/, "");
  return `${trimmed} LIMIT ${limit} OFFSET ${offset}`;
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
