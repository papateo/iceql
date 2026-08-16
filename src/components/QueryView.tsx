import { useState, useEffect, useMemo } from "react";
import { v4 as uuidv4 } from "uuid";
import SqlEditor from "./SqlEditor";
import MongoQueryEditor from "./MongoQueryEditor";
import ResultsPanel from "./ResultsPanel";
import type { ColumnInfo, QueryResult } from "../types";
import { parseEditableTable, injectCtid, CTID_ALIAS, parseUseDatabase } from "../utils/sql";
import { parseMongoCollection } from "../utils/mongo";

interface Props {
  tabId: string;
  query: string;
  database: string;
  databases: string[];
  dbType: string;
  schema: Record<string, string[]>;
  dbColumns: Record<string, ColumnInfo[]>;
  isDark: boolean;
  onLoadSchema: () => void;
  onDatabaseChange: (db: string) => void;
  onQueryChange: (q: string) => void;
  onRunQuery: (q: string, queryId: string) => Promise<QueryResult>;
  onCancelQuery: (queryId: string) => void;
  onGetPrimaryKeys: (table: string) => Promise<string[]>;
  onMongoUpdate: (collection: string, idJson: string, field: string, valueJson: string) => Promise<void>;
  onMongoDelete: (collection: string, idJsons: string[]) => Promise<number>;
  onBeginTransaction: (database: string) => Promise<string>;
  onExecuteInTransaction: (txId: string, query: string) => Promise<QueryResult>;
  onCommitTransaction: (txId: string) => Promise<QueryResult>;
  onRollbackTransaction: (txId: string) => Promise<QueryResult>;
}

export default function QueryView({
  query, database, databases, dbType, schema, dbColumns, isDark,
  onLoadSchema, onDatabaseChange, onQueryChange, onRunQuery, onCancelQuery, onGetPrimaryKeys,
  onMongoUpdate, onMongoDelete,
  onBeginTransaction, onExecuteInTransaction, onCommitTransaction, onRollbackTransaction,
}: Props) {
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Only the plain (non-transaction) run path supports cancellation today, so this
  // stays null while a transaction-scoped statement is in flight.
  const [currentQueryId, setCurrentQueryId] = useState<string | null>(null);
  const [lastRunQuery, setLastRunQuery] = useState("");
  const [rowIds, setRowIds] = useState<string[] | null>(null);
  const [primaryKeys, setPrimaryKeys] = useState<string[]>([]);
  const [editorHeight, setEditorHeight] = useState(240);
  const [dragging, setDragging] = useState(false);

  // Transaction state
  const [inTransaction, setInTransaction] = useState(false);
  const [transactionId, setTransactionId] = useState<string | null>(null);
  const [txError, setTxError] = useState<string | null>(null);

  const editableTable = useMemo(() => {
    if (!result || !lastRunQuery) return null;

    if (dbType === "mongodb") {
      // Mongo results are editable whenever the query targeted a real collection and the
      // result carries _id (always true for our query spec, which never drops it) — there's
      // no relational "does every selected column belong to one table" check to make here.
      const token = parseMongoCollection(lastRunQuery);
      if (!token || !result.columns.includes("_id")) return null;
      return Object.keys(schema).find((t) => t.toLowerCase() === token.toLowerCase()) ?? token;
    }

    const token = parseEditableTable(lastRunQuery);
    if (!token) return null;
    const canonical = Object.keys(schema).find((t) => t.toLowerCase() === token);
    if (!canonical) return null;
    const cols = schema[canonical];
    if (cols && cols.length > 0) {
      const colSet = new Set(cols.map((c) => c.toLowerCase()));
      if (!result.columns.every((c) => colSet.has(c.toLowerCase()))) return null;
    }
    return canonical;
  }, [result, lastRunQuery, schema, dbType]);

  // Fetch the primary key for editableTable so edits build a reliable `WHERE pk = ...` clause
  // instead of matching on every column (which breaks the moment any other column goes stale —
  // e.g. another user editing the same row concurrently).
  useEffect(() => {
    if (!editableTable) { setPrimaryKeys([]); return; }
    let cancelled = false;
    onGetPrimaryKeys(editableTable).then((pks) => { if (!cancelled) setPrimaryKeys(pks); });
    return () => { cancelled = true; };
  }, [editableTable, onGetPrimaryKeys]);

  // Schema default values for editableTable, for "Set Default" in the edit-cell context menu.
  const columnDefaults = useMemo(() => {
    if (!editableTable) return {};
    const cols = dbColumns[`${database}.${editableTable}`];
    if (!cols) return {};
    const map: Record<string, string | null> = {};
    cols.forEach((c) => { map[c.name] = c.column_default; });
    return map;
  }, [dbColumns, database, editableTable]);

  useEffect(() => {
    if (database) onLoadSchema();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [database]);

  const applyResult = (res: QueryResult, q: string, useCtid: boolean) => {
    if (useCtid) {
      const idx = res.columns.indexOf(CTID_ALIAS);
      if (idx !== -1) {
        setRowIds(res.rows.map((r) => String(r[idx])));
        setResult({
          ...res,
          columns: res.columns.filter((_, i) => i !== idx),
          rows: res.rows.map((r) => r.filter((_, i) => i !== idx)),
        });
      } else {
        setRowIds(null);
        setResult(res);
      }
    } else {
      setRowIds(null);
      setResult(res);
    }
    setLastRunQuery(q);
  };

  const runQuery = async (q: string) => {
    if (!q.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const useCtid = dbType === "postgresql" && parseEditableTable(q) !== null;
      const finalQ = useCtid ? injectCtid(q) : q;

      let res: QueryResult;
      if (inTransaction && transactionId) {
        res = await onExecuteInTransaction(transactionId, finalQ);
      } else {
        const queryId = uuidv4();
        setCurrentQueryId(queryId);
        res = await onRunQuery(finalQ, queryId);
      }
      applyResult(res, q, useCtid);

      // The backend has no persistent session — it just runs each query against whatever
      // database the tab currently points at. Mirror a successful `USE db;` into the tab's
      // database selector so subsequent queries actually run against the new database.
      if (dbType === "mysql") {
        const useDb = parseUseDatabase(q);
        if (useDb) {
          const canonical = databases.find((d) => d.toLowerCase() === useDb.toLowerCase());
          if (canonical && canonical !== database) onDatabaseChange(canonical);
        }
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
      setCurrentQueryId(null);
    }
  };

  const handleCancelQuery = () => {
    if (currentQueryId) onCancelQuery(currentQueryId);
  };

  const handleCommit = async (sqls: string[]): Promise<number> => {
    let affected = 0;
    for (const sql of sqls) {
      // While a transaction is active, grid edits (Save/Delete) join it instead of
      // autocommitting immediately — same connection the SQL editor's Run uses, so a
      // Rollback undoes them too.
      const res = inTransaction && transactionId
        ? await onExecuteInTransaction(transactionId, sql)
        : await onRunQuery(sql, uuidv4());
      affected += res.row_count ?? 0;
    }
    if (lastRunQuery) await runQuery(lastRunQuery);
    return affected;
  };

  // Mongo edits (ResultsPanel) go straight through onMongoUpdate/onMongoDelete rather than
  // handleCommit's SQL loop — this is the equivalent "refresh after the batch of edits" step.
  const handleMongoRefresh = async () => {
    if (lastRunQuery) await runQuery(lastRunQuery);
  };

  const handleToggleTransaction = async () => {
    if (inTransaction) return; // use commit/rollback buttons to end
    setTxError(null);
    try {
      const txId = await onBeginTransaction(database);
      setTransactionId(txId);
      setInTransaction(true);
    } catch (e) {
      setTxError(String(e));
    }
  };

  const handleCommitTransaction = async () => {
    if (!transactionId) return;
    setLoading(true);
    setTxError(null);
    try {
      const res = await onCommitTransaction(transactionId);
      setResult(res);
      setLastRunQuery("COMMIT");
    } catch (e) {
      setTxError(String(e));
    } finally {
      setInTransaction(false);
      setTransactionId(null);
      setLoading(false);
    }
  };

  const handleRollbackTransaction = async () => {
    if (!transactionId) return;
    setLoading(true);
    setTxError(null);
    try {
      const res = await onRollbackTransaction(transactionId);
      setResult(res);
      setLastRunQuery("ROLLBACK");
    } catch (e) {
      setTxError(String(e));
    } finally {
      setInTransaction(false);
      setTransactionId(null);
      setLoading(false);
    }
  };

  const handleDividerMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
    const startY = e.clientY;
    const startH = editorHeight;
    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientY - startY;
      setEditorHeight(Math.max(80, Math.min(600, startH + delta)));
    };
    const onUp = () => {
      setDragging(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div className="flex flex-col h-full">
      <div style={{ height: editorHeight, flexShrink: 0 }}>
        {dbType === "mongodb" ? (
          <MongoQueryEditor
            value={query}
            onChange={onQueryChange}
            onRun={runQuery}
            running={loading}
            onCancel={currentQueryId ? handleCancelQuery : undefined}
            database={database}
            databases={databases}
            schema={schema}
            isDark={isDark}
            onDatabaseChange={onDatabaseChange}
          />
        ) : (
          <SqlEditor
            value={query}
            onChange={onQueryChange}
            onRun={runQuery}
            running={loading}
            onCancel={currentQueryId ? handleCancelQuery : undefined}
            database={database}
            databases={databases}
            dbType={dbType}
            schema={schema}
            isDark={isDark}
            onDatabaseChange={onDatabaseChange}
            inTransaction={inTransaction}
            onToggleTransaction={handleToggleTransaction}
            onCommitTransaction={handleCommitTransaction}
            onRollbackTransaction={handleRollbackTransaction}
          />
        )}
      </div>

      {txError && (
        <div className="px-3 py-1.5 text-xs text-red-400 bg-red-400/10 border-b border-border">
          Transaction error: {txError}
        </div>
      )}

      {/* Drag handle */}
      <div
        className={`h-1 cursor-row-resize border-y border-border hover:bg-highlight/30 transition-colors ${
          dragging ? "bg-highlight/30" : "bg-sidebar"
        }`}
        onMouseDown={handleDividerMouseDown}
      />

      <div className="flex-1 overflow-hidden">
        <ResultsPanel
          result={result}
          error={error}
          loading={loading}
          editableTable={editableTable}
          dbType={dbType}
          database={database}
          rowIds={rowIds}
          primaryKeys={primaryKeys}
          columnDefaults={columnDefaults}
          onCommit={handleCommit}
          onMongoUpdate={onMongoUpdate}
          onMongoDelete={onMongoDelete}
          onMongoRefresh={handleMongoRefresh}
        />
      </div>
    </div>
  );
}
